# RushDesk Voice Worker (Python) 🎙️⚡

Worker vocal autonome haute performance et ultra-économique pour **RushDesk**, propulsé par **Google Gemini 2.0 Flash**, **Deepgram**, **Cartesia** et **FastAPI / Pipecat**.

---

## 🌟 Fonctionnalités

- **Latence record (< 400 ms)** : Dialogue fluide et naturel sans délai robotique.
- **Interruption instantanée (Barge-in)** : L'IA se tait immédiatement dès que le client reprend la parole.
- **Intelligence Fast-Food** : Maîtrise des menus, formules, suppléments, sauces, retraits d'ingrédients et upselling.
- **Intégration directe KDS** : Envoi instantané des commandes sur le tableau de bord cuisine Next.js (`POST /api/voice/submit-order`).
- **Support Téléphonique & Local** : Prêt pour Twilio Media Streams et testable localement.

---

## 🚀 Installation & Démarrage rapide

### 1. Cloner / Se positionner dans le dossier
```bash
cd rushdesk-voice
```

### 2. Installer les dépendances
```bash
pip install -r requirements.txt
```

### 3. Configurer l'environnement
Copiez `.env.example` en `.env` et renseignez votre clé Gemini :
```env
GEMINI_API_KEY="votre-cle-api"
GEMINI_MODEL="gemini-2.0-flash"
RUSHDESK_API_URL="http://localhost:3000/api/voice/submit-order"
```

---

## 🧪 Tester l'Agent

### Mode 1 : Test Automatisé
Simule un scénario complet de commande fast-food et vérifie le déclenchement de la commande :
```bash
python local_test.py --auto
```

### Mode 2 : Mode Interactif (Console)
Discutez directement avec Alex pour tester ses réponses :
```bash
python local_test.py --interactive
```

---

## 🌐 Lancer le Serveur API & WebSocket

Pour démarrer le serveur FastAPI pour Twilio :
```bash
python -m src.server
```
Le serveur écoutera sur `http://localhost:8765`.
- **Health Check :** `http://localhost:8765/health`
- **Flux TwiML :** `http://localhost:8765/twiml`
- **Flux WebSocket Twilio :** `ws://localhost:8765/ws/twilio`
