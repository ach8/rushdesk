import subprocess
import re
import sys
import os
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from twilio.rest import Client

load_dotenv()

ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
PHONE_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+33159480286")

def start_tunnel_and_update_twilio():
    print("🚀 Démarrage du tunnel Pinggy sécurisé...")
    proc = subprocess.Popen(
        ["ssh", "-p", "443", "-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", "-R0:127.0.0.1:8765", "a.pinggy.io"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )

    public_url = None
    # Lire les premières lignes pour extraire l'URL
    for _ in range(15):
        line = proc.stdout.readline()
        print("Pinggy:", line.strip())
        match = re.search(r"https://[a-zA-Z0-9\-\.]+\.pinggy\.net", line)
        if match:
            public_url = match.group(0)
            break
        match2 = re.search(r"https://[a-zA-Z0-9\-\.]+\.pinggy-free\.link", line)
        if match2:
            public_url = match2.group(0)
            break

    if not public_url:
        print("❌ Impossible de récupérer l'URL Pinggy.")
        return

    print(f"\n✅ Tunnel public actif : {public_url}")

    # Mise à jour Twilio
    twiml_url = f"{public_url}/twiml"
    print(f"🔄 Mise à jour du numéro Twilio ({PHONE_NUMBER}) vers : {twiml_url}...")
    try:
        tw_client = Client(ACCOUNT_SID, AUTH_TOKEN)
        for num in tw_client.incoming_phone_numbers.list():
            if num.phone_number == PHONE_NUMBER or PHONE_NUMBER in num.phone_number:
                tw_client.incoming_phone_numbers(num.sid).update(
                    voice_url=twiml_url,
                    voice_method="POST"
                )
                print(f"🎉 Twilio configuré avec succès avec : {twiml_url} !\n")
                break
    except Exception as e:
        print(f"⚠️ Erreur mise à jour Twilio: {e}")

    # Maintenir le processus en vie
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()

if __name__ == "__main__":
    start_tunnel_and_update_twilio()
