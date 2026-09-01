import asyncio
import time
from cartesia import AsyncCartesia

async def test():
    client = AsyncCartesia(api_key="sk_car_RmGzSDYq3SWYGEwxFRVyub")
    voice_id = "c6ccfe32-6bee-484a-a8a2-7a51bee93f99"  # Étienne (Français)
    
    ws = await client.tts.websocket()
    
    t0 = time.perf_counter()
    ctx = await ws.send(
        model_id="sonic-preview",
        transcript="Bonjour et bienvenue chez RushDesk ! Je suis Alex.",
        voice={"mode": "id", "id": voice_id},
        output_format={
            "container": "raw",
            "encoding": "pcm_mulaw",
            "sample_rate": 8000,
        },
        language="fr"
    )

    t_first = None
    total_bytes = 0
    chunks = 0

    async for chunk in ctx:
        audio_data = getattr(chunk, "audio", None)
        if t_first is None and audio_data:
            t_first = time.perf_counter()
            print(f"[CARTESIA WS] 1er PAQUET MULAW 8kHz RECU EN : {(t_first - t0)*1000:.0f} ms !")
        if audio_data:
            total_bytes += len(audio_data)
            chunks += 1

    await ws.close()
    t_end = time.perf_counter()
    print(f"[CARTESIA WS] Termine ! {total_bytes} octets ({chunks} chunks) en {(t_end - t0)*1000:.0f} ms")

if __name__ == "__main__":
    asyncio.run(test())
