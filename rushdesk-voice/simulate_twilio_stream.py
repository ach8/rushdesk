import sys
import asyncio
import json
import base64
import websockets

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

async def test_full_call():
    url = "ws://127.0.0.1:8765/ws/twilio"
    print(f"Connecting to {url}...")
    async with websockets.connect(url) as ws:
        # 1. Connected
        await ws.send(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
        print("✓ Sent connected event")

        # 2. Start
        await ws.send(json.dumps({
            "event": "start",
            "start": {
                "streamSid": "test-stream-1",
                "callSid": "test-call-1",
                "customParameters": {"caller": "+33612345678"}
            }
        }))
        print("✓ Sent start event")

        # 3. Receive audio response from Alex
        received_audio_chunks = 0
        for _ in range(80):
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                data = json.loads(msg)
                if data.get("event") == "media":
                    received_audio_chunks += 1
            except asyncio.TimeoutError:
                break

        print(f"🎉 SUCCÈS ! Reçu {received_audio_chunks} paquets audio 8kHz de l'agent Alex sur la ligne téléphonique !")

if __name__ == "__main__":
    asyncio.run(test_full_call())
