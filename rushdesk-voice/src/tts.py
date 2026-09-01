import io
import base64
import logging
from typing import AsyncGenerator
import edge_tts

logger = logging.getLogger("rushdesk.tts")

# Voix françaises recommandées pour la rapidité et le réalisme
# "fr-FR-DeniseNeural" : La plus rapide et naturelle pour le service client
# "fr-FR-HenriNeural"  : Voix masculine très rapide et posée
DEFAULT_VOICE = "fr-FR-DeniseNeural"

async def stream_neural_audio(text: str, voice: str = DEFAULT_VOICE, rate: str = "+12%") -> AsyncGenerator[bytes, None]:
    """
    Générateur de streaming audio MP3 haute performance.
    Envoie les paquets audio au navigateur dès les premiers millisecondes sans mise en mémoire tampon.
    """
    if not text:
        return

    try:
        communicate = edge_tts.Communicate(text, voice=voice, rate=rate)
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and "data" in chunk:
                yield chunk["data"]
    except Exception as e:
        logger.error(f"Error in audio stream: {e}", exc_info=True)

async def generate_neural_audio_base64(text: str, voice: str = DEFAULT_VOICE, rate: str = "+12%") -> str:
    """
    Génère l'audio en mémoire pour fallback.
    """
    if not text:
        return ""
    try:
        communicate = edge_tts.Communicate(text, voice=voice, rate=rate)
        audio_buffer = bytearray()
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and "data" in chunk:
                audio_buffer.extend(chunk["data"])
        b64 = base64.b64encode(audio_buffer).decode("utf-8")
        return f"data:audio/mp3;base64,{b64}"
    except Exception as e:
        logger.error(f"Error in base64 audio gen: {e}")
        return ""
