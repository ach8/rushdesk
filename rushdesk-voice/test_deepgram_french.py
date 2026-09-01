import asyncio
import urllib.parse
import websockets
import os
from dotenv import load_dotenv

load_dotenv()

async def test():
    api_key = os.getenv("DEEPGRAM_API_KEY")
    keywords = [
        "burger:3", "burgers:3", "pizza:3", "pizzas:3", "margherita:3",
        "frites:3", "salade:3", "salades:3", "césar:3", "boisson:3", "boissons:3",
        "coca:3", "coca zéro:3", "eau:3", "menu:3", "commande:3", "classic:3",
        "emporter:3", "sur place:3", "combien:3", "prix:3", "annuler:3", "valider:3",
        "ajouter:3", "supprimer:3", "poisson:3", "poulet:3"
    ]
    kw_params = "&".join([f"keywords={urllib.parse.quote(kw)}" for kw in keywords])

    url = (
        f"wss://api.deepgram.com/v1/listen?"
        f"encoding=mulaw&"
        f"sample_rate=8000&"
        f"channels=1&"
        f"model=nova-2&"
        f"language=fr&"
        f"endpointing=300&"
        f"smart_format=true&"
        f"interim_results=true&"
        f"vad_events=true&"
        f"{kw_params}"
    )

    headers = {"Authorization": f"Token {api_key}"}
    try:
        ws = await websockets.connect(url, additional_headers=headers)
        print("[SUCCESS] Deepgram Nova-2 Connecte avec Boosting Mots-Cles Restauration !")
        await ws.close()
    except Exception as e:
        print(f"[FAIL] {e}")

if __name__ == "__main__":
    asyncio.run(test())
