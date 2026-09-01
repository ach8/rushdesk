import io
import asyncio
import audioop
import edge_tts
from pydub import AudioSegment

async def main():
    comm = edge_tts.Communicate("Bonjour et bienvenue chez RushDesk", voice="fr-FR-DeniseNeural")
    buf = bytearray()
    async for chunk in comm.stream():
        if chunk.get("type") == "audio":
            buf.extend(chunk["data"])
            
    print(f"Downloaded {len(buf)} bytes of MP3")
    seg = AudioSegment.from_file(io.BytesIO(buf), format="mp3")
    seg = seg.set_frame_rate(8000).set_channels(1).set_sample_width(2)
    pcm = seg.raw_data
    ulaw = audioop.lin2ulaw(pcm, 2)
    print(f"Generated {len(ulaw)} bytes of 8000Hz ulaw ({len(ulaw)/8000:.2f}s of audio)")

if __name__ == "__main__":
    asyncio.run(main())
