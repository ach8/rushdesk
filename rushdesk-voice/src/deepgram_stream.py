"""
Deepgram Live Streaming STT Bridge for Twilio Media Streams.
Connecte un flux WebSocket direct vers Deepgram Nova-2 (modèle français, encodage mu-law 8000Hz).
Détecte la fin de parole en ~300ms grâce à l'endpointing intelligent de Deepgram.
"""

import json
import logging
import asyncio
from typing import Callable, Awaitable, Optional
import websockets
from .config import settings

logger = logging.getLogger("rushdesk.deepgram")

import urllib.parse

class DeepgramLiveStreamer:
    def __init__(
        self,
        api_key: Optional[str] = None,
        on_transcript_callback: Optional[Callable[[str], Awaitable[None]]] = None,
        endpointing_ms: int = 300,
        language: str = "fr",
        model: str = "nova-3",
    ):
        self.api_key = api_key or settings.deepgram_api_key
        self.on_transcript = on_transcript_callback
        self.endpointing_ms = endpointing_ms
        self.language = language
        self.model = model
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        self.is_connected = False
        self._receive_task: Optional[asyncio.Task] = None
        self._accumulated_transcript = []
        self._flush_timer: Optional[asyncio.Task] = None

    async def start(self):
        """Établit la connexion WebSocket avec Deepgram Nova-3."""
        if not self.api_key:
            logger.warning("Deepgram API Key non configurée. Impossible de démarrer Deepgram STT.")
            return False

        keyterms = [
            "classic burger", "burger", "pizza margherita", "pizza", "salade césar", "salade",
            "frites croustillantes", "frites", "coca", "coca cola", "boisson", "menu",
            "combien de produits", "combien ça coûte", "quel est le prix",
            "à emporter", "sur place", "valider la commande", "annuler"
        ]
        kt_params = "&".join([f"keyterm={urllib.parse.quote(kt)}" for kt in keyterms])

        url = (
            f"wss://api.deepgram.com/v1/listen?"
            f"encoding=mulaw&"
            f"sample_rate=8000&"
            f"channels=1&"
            f"model={self.model}&"
            f"language={self.language}&"
            f"endpointing={self.endpointing_ms}&"
            f"smart_format=true&"
            f"punctuate=true&"
            f"interim_results=true&"
            f"vad_events=true&"
            f"{kt_params}"
        )

        headers = {
            "Authorization": f"Token {self.api_key}"
        }

        try:
            self.ws = await websockets.connect(url, additional_headers=headers)
            self.is_connected = True
            self._receive_task = asyncio.create_task(self._receive_loop())
            logger.info(f"Connecté à Deepgram Nova-2 ({self.language}, endpointing={self.endpointing_ms}ms + Keywords Boost)")
            return True
        except Exception as e:
            logger.error(f"Erreur de connexion à Deepgram: {e}", exc_info=True)
            self.is_connected = False
            return False

    async def send_audio(self, raw_mulaw_bytes: bytes):
        """Envoie des données audio brutes (µ-law 8000Hz) directement à Deepgram."""
        if self.is_connected and self.ws:
            try:
                await self.ws.send(raw_mulaw_bytes)
            except Exception as e:
                logger.error(f"Erreur d'envoi audio vers Deepgram: {e}")

    async def _receive_loop(self):
        """Écoute les réponses JSON de Deepgram en continu."""
        try:
            async for message in self.ws:
                data = json.loads(message)
                msg_type = data.get("type")

                if msg_type == "Results":
                    channel = data.get("channel", {})
                    alternatives = channel.get("alternatives", [])
                    if not alternatives:
                        continue

                    transcript = alternatives[0].get("transcript", "").strip()
                    is_final = data.get("is_final", False)
                    speech_final = data.get("speech_final", False)

                    # Enregistrement du texte finalisé ou de fin de parole
                    if transcript and (is_final or speech_final):
                        if not self._accumulated_transcript or self._accumulated_transcript[-1] != transcript:
                            self._accumulated_transcript.append(transcript)
                            logger.debug(f"[Deepgram Piece] {transcript}")

                    if speech_final:
                        if self._flush_timer and not self._flush_timer.done():
                            self._flush_timer.cancel()
                        await self._flush_transcript()
                    elif is_final and self._accumulated_transcript:
                        if self._flush_timer and not self._flush_timer.done():
                            self._flush_timer.cancel()
                        self._flush_timer = asyncio.create_task(self._delayed_flush(0.35))

                elif msg_type == "UtteranceEnd":
                    if self._accumulated_transcript:
                        if self._flush_timer and not self._flush_timer.done():
                            self._flush_timer.cancel()
                        await self._flush_transcript()

        except websockets.exceptions.ConnectionClosed:
            logger.info("Connexion Deepgram WebSocket fermée.")
        except Exception as e:
            logger.error(f"Erreur dans receive_loop Deepgram: {e}", exc_info=True)
        finally:
            self.is_connected = False

    async def _delayed_flush(self, delay: float):
        try:
            await asyncio.sleep(delay)
            await self._flush_transcript()
        except asyncio.CancelledError:
            pass

    async def _flush_transcript(self):
        if self._flush_timer and not self._flush_timer.done():
            self._flush_timer.cancel()
        final_text = " ".join(self._accumulated_transcript).strip()
        self._accumulated_transcript = []
        if len(final_text) >= 2 and self.on_transcript:
            logger.info(f"[Deepgram Nova-2 STT] Transcription finale : '{final_text}'")
            await self.on_transcript(final_text)

    async def close(self):
        """Ferme proprement la connexion WebSocket."""
        self.is_connected = False
        if self.ws:
            try:
                # Envoyer un message vide pour finaliser selon le protocole Deepgram
                await self.ws.send(json.dumps({"type": "CloseStream"}))
                await self.ws.close()
            except Exception:
                pass
        if self._receive_task and not self._receive_task.done():
            self._receive_task.cancel()
