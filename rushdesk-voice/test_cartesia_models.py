import asyncio
import time
from cartesia import AsyncCartesia

async def test():
    client = AsyncCartesia(api_key="sk_car_RmGzSDYq3SWYGEwxFRVyub")
    voice_id = "c6ccfe32-6bee-484a-a8a2-7a51bee93f99"  # Étienne (Français)
    
    t0 = time.perf_counter()
    response = await client.tts.generate(
        model_id="sonic-preview",
        transcript="Bonjour et bienvenue chez RushDesk ! Je suis Alex. Que puis-je vous servir ?",
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
    async for chunk in response.iter_bytes(chunk_size=800):
        if t_first is None and chunk:
            t_first = time.perf_counter()
            print(f"[CARTESIA SONIC] PREMIER PAQUET MULAW 8000Hz RECU EN : {(t_first - t0)*1000:.0f} ms !")
        if chunk:
            total_bytes += len(chunk)
            chunks += 1

    t_end = time.perf_counter()
    print(f"Succes ! Total {total_bytes} octets ({chunks} chunks de 100ms) recus en {(t_end - t0)*1000:.0f} ms")

if __name__ == "__main__":
    asyncio.run(test())
