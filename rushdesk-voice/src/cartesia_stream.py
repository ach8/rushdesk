"""
Cartesia Sonic Real-Time TTS Streamer for Twilio Media Streams.
Génère de l'audio natif mu-law 8000Hz en streaming direct WebSocket/SSE avec une latence sub-100ms.
"""

import time
import logging
from typing import AsyncGenerator, Optional
from cartesia import AsyncCartesia
from .config import settings

logger = logging.getLogger("rushdesk.cartesia")

class CartesiaStreamer:
    def __init__(
        self,
        api_key: Optional[str] = None,
        voice_id: Optional[str] = None,
        model_id: str = "sonic-preview"
    ):
        self.api_key = api_key or settings.cartesia_api_key
        self.voice_id = voice_id or settings.cartesia_voice_id or "c6ccfe32-6bee-484a-a8a2-7a51bee93f99"
        self.model_id = model_id
        self.client: Optional[AsyncCartesia] = None

        if self.api_key:
            self.client = AsyncCartesia(api_key=self.api_key)
            logger.info(f"Cartesia Sonic initialisé (Modèle: {self.model_id}, Voix: {self.voice_id})")

    async def stream_mulaw(self, text: str, voice_id: Optional[str] = None) -> AsyncGenerator[bytes, None]:
        """
        Génère et produit des paquets audio mu-law 8000Hz (format natif Twilio) au fil de l'eau.
        Zéro conversion, zéro temporisation.
        """
        if not self.client or not text:
            return

        v_id = voice_id or self.voice_id
        t0 = time.perf_counter()
        first_chunk = False

        try:
            response = await self.client.tts.generate(
                model_id=self.model_id,
                transcript=text,
                voice={"mode": "id", "id": v_id},
                output_format={
                    "container": "raw",
                    "encoding": "pcm_mulaw",
                    "sample_rate": 8000,
                },
                language="fr"
            )

            # Émet par paquets de 800 octets (100ms d'audio 8kHz)
            async for chunk in response.iter_bytes(chunk_size=800):
                if chunk:
                    if not first_chunk:
                        first_chunk = True
                        t_first = time.perf_counter()
                        logger.info(f"[Cartesia Sonic] ⚡ 1er paquet mulaw émis en {(t_first - t0)*1000:.0f}ms !")
                    yield chunk

        except Exception as e:
            logger.error(f"Erreur streaming Cartesia: {e}", exc_info=True)
