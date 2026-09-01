import asyncio
import time
import base64
import json
import edge_tts

async def speak_text(text: str):
    t0 = time.perf_counter()
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-acodec", "pcm_mulaw", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )

    comm = edge_tts.Communicate(text, voice="fr-FR-VivienneMultilingualNeural", rate="+5%")

    async def feed_ffmpeg():
        try:
            async for chunk in comm.stream():
                if chunk.get("type") == "audio" and proc.stdin:
                    proc.stdin.write(chunk["data"])
                    await proc.stdin.drain()
        except Exception as e:
            print(f"Feed error: {e}")
        finally:
            if proc.stdin:
                try:
                    proc.stdin.close()
                    await proc.stdin.wait_closed()
                except Exception:
                    pass

    feed_task = asyncio.create_task(feed_ffmpeg())

    CHUNK_SIZE = 800
    first_chunk_sent = False
    chunks_sent = 0

    while True:
        data = await proc.stdout.read(CHUNK_SIZE)
        if not data:
            break

        if not first_chunk_sent:
            first_chunk_sent = True
            t_first = time.perf_counter()
            print(f"[SUCCESS] 1er paquet pret en {(t_first - t0)*1000:.0f}ms !")
        chunks_sent += 1

    await feed_task
    await proc.wait()
    t_end = time.perf_counter()
    print(f"[SUCCESS] Total: {chunks_sent} chunks recus en {(t_end - t0)*1000:.0f}ms")

if __name__ == "__main__":
    asyncio.run(speak_text("Bonjour et bienvenue chez RushDesk ! Je suis Alex. Que puis-je vous preparer aujourd'hui ?"))
