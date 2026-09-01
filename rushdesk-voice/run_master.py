"""
Serveur Vocal Maître Tout-en-un Ultra-Résistant avec Superviseur Auto-Healing.
Gère le tunnel Cloudflare avec synchronisation initiale garantie,
redémarrage automatique en cas de coupure, surveillance périodique et serveur FastAPI.
"""

import subprocess
import re
import sys
import os
import time
import threading
import httpx

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
CF_EXE = os.path.join(os.path.dirname(__file__), "cloudflared.exe")

current_tunnel_url = None
current_cf_proc = None
is_running = True
lock = threading.Lock()

def update_twilio(url: str):
    twiml_url = f"{url}/twiml"
    print(f"\n⚙️  Mise à jour Webhook Twilio : {twiml_url}")
    try:
        tw_client = Client(ACCOUNT_SID, AUTH_TOKEN)
        for num in tw_client.incoming_phone_numbers.list():
            if num.phone_number == PHONE_NUMBER or PHONE_NUMBER in num.phone_number:
                tw_client.incoming_phone_numbers(num.sid).update(
                    voice_url=twiml_url,
                    voice_method="POST"
                )
                print(f"✓ Twilio synchronisé avec succès sur : {twiml_url}")
                break
    except Exception as e:
        print(f"⚠️ Erreur Twilio: {e}")

def start_new_tunnel():
    """Démarre une nouvelle instance de cloudflared et extrait l'URL."""
    global current_cf_proc, current_tunnel_url
    
    print("\n🌐 Lancement du tunnel Cloudflare haute vitesse...")
    proc = subprocess.Popen(
        [CF_EXE, "tunnel", "--url", f"http://127.0.0.1:{PORT}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1
    )

    detected_url = None
    # Lecture des 50 premières lignes pour attraper l'URL
    for _ in range(80):
        line = proc.stderr.readline()
        if not line:
            time.sleep(0.1)
            continue
        match = re.search(r"https://[a-zA-Z0-9\-\.]+\.trycloudflare\.com", line)
        if match:
            detected_url = match.group(0)
            break

    if detected_url:
        with lock:
            current_cf_proc = proc
            current_tunnel_url = detected_url
        print(f"✓ URL Publique Active : {detected_url}")
        update_twilio(detected_url)
        return proc
    else:
        print("❌ Impossible de détecter l'URL Cloudflare, fermeture du processus...")
        proc.kill()
        return None

def tunnel_supervisor():
    """Surveille le tunnel Cloudflare et le relance immédiatement s'il tombe."""
    global current_tunnel_url, current_cf_proc, is_running

    while is_running:
        time.sleep(5)
        need_restart = False
        with lock:
            if not current_cf_proc or current_cf_proc.poll() is not None:
                need_restart = True

        if need_restart and is_running:
            print("⚠️ Tunnel déconnecté ! Relance automatique en cours...")
            start_new_tunnel()

def health_checker():
    """Teste la joignabilité de l'URL publique toutes les 25s."""
    global current_tunnel_url, current_cf_proc, is_running
    time.sleep(30) # Attente démarrage FastAPI
    failures = 0

    while is_running:
        time.sleep(25)
        if not is_running or not current_tunnel_url:
            continue

        try:
            with httpx.Client(timeout=6.0) as client:
                r = client.get(f"{current_tunnel_url}/health")
                if r.status_code == 200:
                    failures = 0
                    continue
        except Exception:
            pass

        failures += 1
        if failures >= 3 and is_running:
            print(f"⚠️ [HealthCheck] URL {current_tunnel_url} ne répond plus. Forçage du redémarrage...")
            failures = 0
            with lock:
                if current_cf_proc:
                    try:
                        current_cf_proc.kill()
                    except Exception:
                        pass

def main():
    global is_running
    print("\n=======================================================")
    print("  🚀 SERVEUR VOCAL RUSHESK (DEEPGRAM NOVA-2 + GEMINI)")
    print("=======================================================\n")

    # 1. Démarrage garanti du premier tunnel
    proc = None
    for attempt in range(3):
        proc = start_new_tunnel()
        if proc:
            break
        time.sleep(2)

    if not proc:
        print("❌ Échec critique du tunnel Cloudflare. Arrêt.")
        return

    # 2. Lancement des threads de supervision et health-check
    t_sup = threading.Thread(target=tunnel_supervisor, daemon=True)
    t_sup.start()

    t_hc = threading.Thread(target=health_checker, daemon=True)
    t_hc.start()

    print("\n=======================================================")
    print(f"  🎉 LE SERVEUR EST EN LIGNE ET 100% OPÉRATIONNEL !")
    print(f"  📞 Composez le : {PHONE_NUMBER}")
    print("=======================================================\n")

    # 3. Démarrage de l'application FastAPI
    try:
        from src.server import app
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
    finally:
        is_running = False
        with lock:
            if current_cf_proc:
                try:
                    current_cf_proc.kill()
                except Exception:
                    pass

if __name__ == "__main__":
    main()
