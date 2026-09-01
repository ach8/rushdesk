import asyncio
import subprocess
import time
import base64
import json
import edge_tts

async def test_streaming():
    t0 = time.perf_counter()
    text = "On a des burgers, des pizzas, des salades et des frites. Vous cherchez quoi ?"
    
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-acodec", "pcm_mulaw", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        bufsize=0
    )

    comm = edge_tts.Communicate(text, voice="fr-FR-VivienneMultilingualNeural", rate="+5%")

    async def feed_ffmpeg():
        try:
            async for chunk in comm.stream():
                if chunk.get("type") == "audio" and proc and proc.stdin:
                    proc.stdin.write(chunk["data"])
                    proc.stdin.flush()
        except Exception as e:
            print(f"Feed error: {e}")
        finally:
            if proc and proc.stdin and not proc.stdin.closed:
                proc.stdin.close()

    feed_task = asyncio.create_task(feed_ffmpeg())

    loop = asyncio.get_running_loop()
    CHUNK_SIZE = 800
    first_chunk = False
    total_bytes = 0

    while True:
        data = await loop.run_in_executor(None, proc.stdout.read, CHUNK_SIZE)
        if not data:
            break
        if not first_chunk:
            first_chunk = True
            t_first = time.perf_counter()
            print(f"[SUCCESS] PREMIER PAQUET AUDIO PRET EN : {(t_first - t0)*1000:.0f} ms !")
        total_bytes += len(data)

    await feed_task
    proc.wait()
    t_end = time.perf_counter()
    print(f"Total: {total_bytes} bytes in {(t_end - t0)*1000:.0f} ms")

if __name__ == "__main__":
    asyncio.run(test_streaming())
