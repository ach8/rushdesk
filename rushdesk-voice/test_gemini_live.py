import os
import sys
import asyncio

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

async def test_live():
    client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
    models_to_test = [
        "gemini-2.0-flash-exp",
        "gemini-2.0-flash",
        "gemini-2.5-flash"
    ]

    for model in models_to_test:
        print(f"Testing live connect on model: {model}...")
        try:
            config = types.LiveConnectConfig(
                response_modalities=["AUDIO"]
            )
            async with client.aio.live.connect(model=model, config=config) as session:
                print(f"SUCCESS! Model {model} is ACTIVE and supports Multimodal Live WebSocket!")
                return model
        except Exception as e:
            print(f"Model {model} error: {e}\n")

if __name__ == "__main__":
    asyncio.run(test_live())
