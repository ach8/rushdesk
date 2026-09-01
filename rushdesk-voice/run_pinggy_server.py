"""
Master Launcher All-in-One: Pinggy Tunnel + Twilio Auto-Update + FastAPI Voice Server.
"""

import subprocess
import re
import sys
import os
import time
import threading

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

from dotenv import load_dotenv
from twilio.rest import Client
import uvicorn

load_dotenv()

ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
PHONE_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+33159480286")
PORT = int(os.getenv("PORT", 8765))

def print_pinggy_logs(proc):
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        # Optionnel: print(f"[Pinggy] {line.strip()}")

def main():
    print("\n=======================================================")
    print("  🚀 DÉMARRAGE DU SERVICE VOCAL RUSHESK + PINGGY")
    print("=======================================================\n")

    print("1. 🌐 Démarrage du tunnel Pinggy...")
    proc = subprocess.Popen(
        ["ssh", "-p", "443", "-o", "StrictHostKeyChecking=no", "-o", "ServerAliveInterval=30", f"-R0:127.0.0.1:{PORT}", "a.pinggy.io"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1
    )

    public_url = None
    for _ in range(30):
        line = proc.stdout.readline()
        if not line:
            time.sleep(0.2)
            continue
        
        match = re.search(r"https://[a-zA-Z0-9\-\.]+\.free\.pinggy\.net", line)
        if match:
            public_url = match.group(0)
            break

    if not public_url:
        print("❌ Impossible d'extraire l'URL Pinggy.")
        proc.terminate()
        return

    print(f"✓ URL Pinggy active : {public_url}")

    # Lancer un thread pour consommer le reste des logs Pinggy
    threading.Thread(target=print_pinggy_logs, args=(proc,), daemon=True).start()

    # 2. Configuration Twilio
    twiml_url = f"{public_url}/twiml"
    print(f"\n2. ⚙️  Mise à jour automatique de Twilio ({PHONE_NUMBER})...")
    try:
        tw_client = Client(ACCOUNT_SID, AUTH_TOKEN)
        for num in tw_client.incoming_phone_numbers.list():
            if num.phone_number == PHONE_NUMBER or PHONE_NUMBER in num.phone_number:
                tw_client.incoming_phone_numbers(num.sid).update(
                    voice_url=twiml_url,
                    voice_method="POST"
                )
                print(f"✓ Twilio configuré avec succès avec : {twiml_url}")
                break
    except Exception as e:
        print(f"⚠️ Erreur mise à jour Twilio: {e}")

    print("\n=======================================================")
    print(f"  🎉 LE SERVEUR EST EN LIGNE ET PRÊT POUR L'APPEL !")
    print(f"  📞 Composez le : {PHONE_NUMBER} sur votre mobile")
    print("=======================================================\n")

    # 3. Lancement du serveur FastAPI
    from src.server import app
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")

if __name__ == "__main__":
    main()
