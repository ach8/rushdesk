"""
Twilio Media Stream Handler — Full-Duplex Realtime Audio WebSocket avec Vosk Local.
Encode et stream l'audio au format natif Twilio (8000Hz mu-law, 20ms chunks).
"""

import io
import re
import json
import time
import base64
import asyncio
import logging
import subprocess
import audioop
from typing import Optional
from fastapi import WebSocket, WebSocketDisconnect
from vosk import Model, KaldiRecognizer
from pydub import AudioSegment
import edge_tts
from .config import settings
from .agent import VoiceOrderAgent

logger = logging.getLogger("rushdesk.media_stream")

# Préchargement du modèle français Vosk
try:
    logger.info("Chargement du modèle français Vosk...")
    vosk_model = Model(lang="fr")
    logger.info("Modèle français Vosk chargé avec succès !")
except Exception as e:
    logger.error(f"Erreur chargement Vosk: {e}")
    vosk_model = None

from .deepgram_stream import DeepgramLiveStreamer
from .cartesia_stream import CartesiaStreamer

class TwilioCallSession:
    def __init__(self, websocket: WebSocket, call_sid: str, stream_sid: str, caller_phone: str):
        self.ws = websocket
        self.call_sid = call_sid
        self.stream_sid = stream_sid
        self.caller_phone = caller_phone
        self.agent = VoiceOrderAgent(conversation_id=f"tw-{call_sid}", caller_phone=caller_phone)
        
        # Initialisation STT : Deepgram (Pro) ou Fallback Vosk (Local)
        self.deepgram: Optional[DeepgramLiveStreamer] = None
        if settings.deepgram_api_key:
            self.deepgram = DeepgramLiveStreamer(
                api_key=settings.deepgram_api_key,
                on_transcript_callback=self._on_deepgram_transcript,
                endpointing_ms=300,
                language="fr",
                model="nova-3"
            )
            self.recognizer = None
            logger.info(f"[{self.call_sid}] Mode STT Flagship actif : Deepgram Nova-3 (Multilingual)")
        else:
            self.recognizer = KaldiRecognizer(vosk_model, 8000.0) if vosk_model else None
            if self.recognizer:
                self.recognizer.SetWords(True)
            logger.info(f"[{self.call_sid}] Mode STT Local actif : Vosk")

        # Initialisation TTS : Cartesia Sonic (Sub-100ms)
        self.cartesia: Optional[CartesiaStreamer] = None
        if settings.cartesia_api_key:
            self.cartesia = CartesiaStreamer(api_key=settings.cartesia_api_key, voice_id=settings.cartesia_voice_id)
            logger.info(f"[{self.call_sid}] Mode TTS Ultra-Rapide actif : Cartesia Sonic ({settings.cartesia_voice_id})")
            
        self.is_running = True
        self.is_speaking = False
        self.current_reply_task: Optional[asyncio.Task] = None
        
        self.generation_id = 0

    async def start(self):
        """Démarre les services de streaming (ex: Deepgram WebSocket)."""
        if self.deepgram:
            await self.deepgram.start()

    async def _on_deepgram_transcript(self, text: str):
        """Callback déclenché instantanément par Deepgram quand l'utilisateur finit de parler."""
        text = text.strip()
        if not self.is_running or not text or len(text) < 2:
            return
        logger.info(f"[Deepgram Nova-2 Live STT] Client ({self.call_sid}): {text}")
        if self.current_reply_task and not self.current_reply_task.done():
            self.current_reply_task.cancel()
        self.current_reply_task = asyncio.create_task(self.handle_user_turn(text))

    async def process_media_chunk(self, payload_b64: str):
        """Reçoit un paquet audio 20ms de Twilio."""
        if not self.is_running:
            return

        try:
            raw_ulaw = base64.b64decode(payload_b64)

            # Route 1 : Deepgram Nova-2 (Envoi direct µ-law, 0 conversion CPU)
            if self.deepgram and self.deepgram.is_connected:
                await self.deepgram.send_audio(raw_ulaw)
                return

            # Route 2 : Fallback Vosk Local (Conversion ulaw -> PCM 16-bit)
            if self.recognizer:
                pcm_data = audioop.ulaw2lin(raw_ulaw, 2)
                if self.recognizer.AcceptWaveform(pcm_data):
                    res = json.loads(self.recognizer.Result())
                    text = res.get("text", "").strip()
                    if text:
                        logger.info(f"[Vosk Live STT] Client ({self.call_sid}): {text}")
                        if self.current_reply_task and not self.current_reply_task.done():
                            self.current_reply_task.cancel()
                        self.current_reply_task = asyncio.create_task(self.handle_user_turn(text))
        except Exception as e:
            logger.error(f"Erreur traitement paquet audio: {e}")

    async def handle_user_turn(self, user_text: str):
        """Reçoit le texte de l'utilisateur, interroge Gemini 3.5 Flash Lite et génère la voix fluide."""
        if not user_text:
            return

        # Barge-in : interruption immédiate si l'IA parlait
        self.generation_id += 1
        my_gen_id = self.generation_id
        if self.is_speaking:
            await self.interrupt_speaking()

        logger.info(f"Envoi au modèle Gemini (Fast): '{user_text}'")
        
        full_reply = []
        try:
            async for text_piece in self.agent.handle_user_message_stream(user_text):
                if self.generation_id != my_gen_id:
                    break # Interrompu par le client
                full_reply.append(text_piece)
            
            complete_text = "".join(full_reply).strip()
            if complete_text and self.generation_id == my_gen_id:
                logger.info(f"[Gemini Response] Alex: '{complete_text}'")
                await self.speak_text(complete_text, my_gen_id)
                
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Erreur handle_user_turn: {e}", exc_info=True)

    async def interrupt_speaking(self):
        """Envoie un signal 'clear' à Twilio pour vider son tampon audio immédiatement."""
        self.is_speaking = False
        try:
            clear_msg = json.dumps({
                "event": "clear",
                "streamSid": self.stream_sid
            })
            await self.ws.send_text(clear_msg)
            logger.info(f"Barge-in: Tampon Twilio vidé pour {self.stream_sid}")
        except Exception as e:
            logger.error(f"Erreur interrupt_speaking: {e}")

    async def speak_text(self, text: str, gen_id: int):
        """Génère la voix en flux direct avec Cartesia Sonic (Sub-100ms) ou Fallback Edge-TTS."""
        if not text or not self.is_running or gen_id != self.generation_id:
            return

        self.is_speaking = True
        t0 = time.perf_counter()
        
        # --- ROUTE 1 : Cartesia Sonic Direct (Format natif mu-law 8000Hz, 0 conversion) ---
        if self.cartesia:
            try:
                first_chunk_sent = False
                async for chunk in self.cartesia.stream_mulaw(text):
                    if not self.is_speaking or not self.is_running or gen_id != self.generation_id:
                        break

                    if not first_chunk_sent:
                        first_chunk_sent = True
                        t_first = time.perf_counter()
                        logger.info(f"[{self.call_sid}] 🚀 1er paquet Cartesia envoyé à Twilio en {(t_first - t0)*1000:.0f}ms !")

                    payload_b64 = base64.b64encode(chunk).decode("utf-8")
                    media_msg = json.dumps({
                        "event": "media",
                        "streamSid": self.stream_sid,
                        "media": {
                            "payload": payload_b64
                        }
                    })
                    await self.ws.send_text(media_msg)

                self.is_speaking = False
                return
            except Exception as e:
                logger.error(f"Erreur Cartesia Sonic, passage au fallback Edge-TTS: {e}")

        # --- ROUTE 2 : Fallback Edge-TTS Asynchrone ---
        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-acodec", "pcm_mulaw", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
            )

            comm = edge_tts.Communicate(text, voice="fr-FR-VivienneMultilingualNeural", rate="+5%")

            async def feed_ffmpeg():
                try:
                    async for chunk in comm.stream():
                        if not self.is_speaking or not self.is_running or gen_id != self.generation_id:
                            break
                        if chunk.get("type") == "audio" and proc and proc.stdin:
                            proc.stdin.write(chunk["data"])
                            await proc.stdin.drain()
                except Exception as e:
                    logger.error(f"Erreur feed ffmpeg: {e}")
                finally:
                    if proc and proc.stdin:
                        try:
                            proc.stdin.close()
                            await proc.stdin.wait_closed()
                        except Exception:
                            pass

            feed_task = asyncio.create_task(feed_ffmpeg())

            CHUNK_SIZE = 800
            first_chunk_sent = False

            while self.is_running and gen_id == self.generation_id:
                data = await proc.stdout.read(CHUNK_SIZE)
                if not data:
                    break

                if not first_chunk_sent:
                    first_chunk_sent = True
                    t_first = time.perf_counter()
                    logger.info(f"[{self.call_sid}] ⚡ 1er paquet Edge-TTS envoyé à Twilio en {(t_first - t0)*1000:.0f}ms !")

                payload_b64 = base64.b64encode(data).decode("utf-8")
                media_msg = json.dumps({
                    "event": "media",
                    "streamSid": self.stream_sid,
                    "media": {
                        "payload": payload_b64
                    }
                })
                await self.ws.send_text(media_msg)

            await feed_task
            await proc.wait()

        except Exception as e:
            logger.error(f"Erreur speak_text streaming: {e}", exc_info=True)
        finally:
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass
            self.is_speaking = False
