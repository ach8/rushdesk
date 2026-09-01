"""
Script d'intégration et de configuration automatique pour Twilio Téléphonie.
"""

import os
import sys
import logging

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+33159480286")

if not ACCOUNT_SID or not AUTH_TOKEN:
    print("❌ Erreur : TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN manquant dans .env")
    sys.exit(1)

client = Client(ACCOUNT_SID, AUTH_TOKEN)

def list_and_verify_numbers():
    print("\n=======================================================")
    print("  📞 VÉRIFICATION DU COMPTE TWILIO & DU NUMÉRO")
    print("=======================================================\n")
    try:
        incoming_numbers = client.incoming_phone_numbers.list()
        if not incoming_numbers:
            print("⚠️ Aucun numéro de téléphone trouvé sur ce compte.")
            return

        print("Numéros actifs trouvés sur votre compte Twilio :")
        for num in incoming_numbers:
            print(f"- Numéro : {num.phone_number} (SID: {num.sid})")
            print(f"  Webhook actuel Voice URL : {num.voice_url}")
            print(f"  Voice Method : {num.voice_method}\n")
    except Exception as e:
        print(f"❌ Erreur de connexion à Twilio : {e}")

def update_number_webhook(public_url: str):
    """Met à jour automatiquement l'URL du webhook vocal sur Twilio."""
    twiml_url = f"{public_url.rstrip('/')}/twiml"
    print(f"\n🔄 Configuration automatique du webhook Twilio vers : {twiml_url}...")

    try:
        incoming_numbers = client.incoming_phone_numbers.list()
        for num in incoming_numbers:
            if num.phone_number == FROM_NUMBER or FROM_NUMBER in num.phone_number:
                client.incoming_phone_numbers(num.sid).update(
                    voice_url=twiml_url,
                    voice_method="POST"
                )
                print(f"✅ Numéro {num.phone_number} configuré avec succès avec l'URL : {twiml_url} !")
                return True
        print(f"⚠️ Numéro {FROM_NUMBER} non trouvé directement dans la liste, vérifiez le format international.")
    except Exception as e:
        print(f"❌ Échec de la mise à jour du webhook sur Twilio : {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].startswith("http"):
        update_number_webhook(sys.argv[1])
    else:
        list_and_verify_numbers()
