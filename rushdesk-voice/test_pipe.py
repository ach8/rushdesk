import asyncio
import subprocess
import time
import edge_tts

async def test():
    comm = edge_tts.Communicate("Bonjour et bienvenue chez RushDesk !", voice="fr-FR-VivienneMultilingualNeural")
    proc = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0", "-f", "mulaw", "-ar", "8000", "-ac", "1", "pipe:1"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        bufsize=0
    )
    
    t0 = time.perf_counter()
    t_first = None
    total_bytes = 0

    async def feed_ffmpeg():
        async for chunk in comm.stream():
            if chunk.get("type") == "audio":
                proc.stdin.write(chunk["data"])
                proc.stdin.flush()
        proc.stdin.close()

    feed_task = asyncio.create_task(feed_ffmpeg())

    # Read in a non-blocking thread or loop
    loop = asyncio.get_running_loop()
    while True:
        data = await loop.run_in_executor(None, proc.stdout.read, 800)
        if not data:
            break
        if t_first is None:
            t_first = time.perf_counter()
            print(f"Time to First 100ms mulaw audio chunk: {(t_first - t0)*1000:.1f}ms")
        total_bytes += len(data)

    await feed_task
    proc.wait()
    t_end = time.perf_counter()
    print(f"Total streaming audio: {total_bytes} bytes in {(t_end - t0)*1000:.1f}ms")

if __name__ == "__main__":
    asyncio.run(test())
