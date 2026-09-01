import os
import sys
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()
api_key = os.getenv("GEMINI_API_KEY")

client = genai.Client(api_key=api_key)

def submit_order(items: list[dict], order_type: str = "TAKEAWAY") -> dict:
    """Envoie la commande confirmée par le client en cuisine sur le tableau de bord RushDesk."""
    print(f"[TOOL TRIGGERED] submit_order called with items={items}, order_type={order_type}")
    return {"status": "success", "order_id": "REC-001", "total": "24.00"}

chat = client.chats.create(
    model="gemini-3.6-flash",
    config=types.GenerateContentConfig(
        system_instruction="Tu es Alex, réceptionniste vocal du restaurant RushDesk. Quand le client confirme sa commande, appelle submit_order.",
        tools=[submit_order],
    )
)

print("1. Envoi du premier message...")
resp1 = chat.send_message("Bonjour, je voudrais 2 Classic Burgers et une frite à emporter.")
print("IA:", resp1.text)

print("\n2. Confirmation de la commande...")
resp2 = chat.send_message("Oui parfait, je confirme la commande !")
print("IA:", resp2.text)
