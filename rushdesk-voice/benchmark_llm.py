import asyncio
import time
import os
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

async def benchmark_model(model_name: str, with_tools: bool):
    client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY"))
    
    def submit_order(items: list[dict], order_type: str = "TAKEAWAY") -> dict:
        return {"status": "ok"}

    config = types.GenerateContentConfig(
        tools=[submit_order] if with_tools else None,
        temperature=0.7,
    )

    t0 = time.perf_counter()
    chat = client.aio.chats.create(model=model_name, config=config)
    res = await chat.send_message_stream("Salut, tu as quoi comme menu ?")
    
    t_first = None
    full_text = []
    async for chunk in res:
        if t_first is None and chunk.text:
            t_first = time.perf_counter()
        if chunk.text:
            full_text.append(chunk.text)
            
    t_end = time.perf_counter()
    ttft = round((t_first - t0) * 1000) if t_first else 0
    total = round((t_end - t0) * 1000)
    print(f"[{model_name}] (Tools={with_tools}) -> TTFT: {ttft}ms | Total: {total}ms | Answer: {''.join(full_text)[:40]}...")

async def main():
    print("--- BENCHMARK LLM LATENCY ---")
    for m in ["gemini-3.5-flash-lite", "gemini-3.6-flash"]:
        for wt in [False, True]:
            try:
                await benchmark_model(m, wt)
            except Exception as e:
                print(f"[{m}] Error: {e}")

if __name__ == "__main__":
    asyncio.run(main())
