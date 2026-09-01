"""
Lanceur complet : Tunnel public + Configuration automatique Twilio + Serveur Vocal Live.
Permet d'appeler le +33 1 59 48 02 86 directement depuis son smartphone.
"""

import os
import sys
import time
import logging

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from pyngrok import ngrok
from twilio.rest import Client
import uvicorn

load_dotenv()

ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
PHONE_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+33159480286")
PORT = int(os.getenv("PORT", 8765))

def main():
    print("\n=======================================================")
    print("  🚀 DÉMARRAGE DU SERVICE TÉLÉPHONIQUE TWILIO")
    print("=======================================================\n")

    if not ACCOUNT_SID or not AUTH_TOKEN:
        print("❌ Erreur : TWILIO_ACCOUNT_SID ou TWILIO_AUTH_TOKEN manquant dans .env")
        return

    # 1. Ouverture du tunnel public HTTPS
    print("1. 🌐 Création du tunnel public HTTPS sécurisé...")
    try:
        tunnel = ngrok.connect(PORT, bind_tls=True)
        public_url = tunnel.public_url.replace("http://", "https://")
        print(f"✓ Tunnel public actif : {public_url}")
    except Exception as e:
        print(f"❌ Erreur lors de la création du tunnel ngrok : {e}")
        print("💡 Note : Si ngrok demande un token gratuit, créez un compte sur ngrok.com et tapez: ngrok config add-authtoken <TOKEN>")
        return

    # 2. Configuration automatique du numéro Twilio
    twiml_url = f"{public_url}/twiml"
    print(f"\n2. ⚙️  Configuration automatique du numéro Twilio ({PHONE_NUMBER})...")
    try:
        tw_client = Client(ACCOUNT_SID, AUTH_TOKEN)
        incoming_numbers = tw_client.incoming_phone_numbers.list()
        
        configured = False
        for num in incoming_numbers:
            if num.phone_number == PHONE_NUMBER or PHONE_NUMBER in num.phone_number:
                tw_client.incoming_phone_numbers(num.sid).update(
                    voice_url=twiml_url,
                    voice_method="POST"
                )
                print(f"✓ Numéro {num.phone_number} relié avec succès à : {twiml_url}")
                configured = True
                break

        if not configured:
            print(f"⚠️ Numéro {PHONE_NUMBER} non trouvé, configuration manuelle requise sur la console Twilio.")
    except Exception as e:
        print(f"⚠️ Impossible de mettre à jour Twilio automatiquement ({e}).")
        print(f"👉 Veuillez coller cette URL dans Twilio (Voice Webhook) : {twiml_url}")

    # 3. Message de confirmation
    print("\n=======================================================")
    print(f"  🎉 LE NUMÉRO EST EN LIGNE ET PRÊT À RECEVOIR DES APPELS !")
    print(f"  📞 Composez le : {PHONE_NUMBER} depuis votre smartphone")
    print(f"  🛎️  Les commandes s'afficheront en direct sur RushDesk")
    print("=======================================================\n")
    print("Appuyez sur CTRL+C pour arrêter le serveur et fermer le tunnel.\n")

    # 4. Lancement du serveur FastAPI
    from src.server import app
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

if __name__ == "__main__":
    main()
