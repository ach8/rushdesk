import asyncio
import os
import websockets
from dotenv import load_dotenv

load_dotenv()

async def test_dg():
    api_key = os.getenv("DEEPGRAM_API_KEY")
    print(f"Testing Deepgram with API Key: {api_key[:6]}...{api_key[-4:]}")
    url = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&language=fr"
    headers = {"Authorization": f"Token {api_key}"}
    try:
        ws = await websockets.connect(url, additional_headers=headers)
        print("[SUCCESS] Connexion Deepgram Nova-2 REUSSIE avec succes !")
        await ws.close()
    except Exception as e:
        print(f"[ERROR] Erreur connexion Deepgram: {e}")

if __name__ == "__main__":
    asyncio.run(test_dg())
