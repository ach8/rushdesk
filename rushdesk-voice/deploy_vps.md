# Guide de Déploiement VPS & Production — RushDesk Voice AI

Ce guide vous accompagne pas à pas pour déployer le serveur vocal RushDesk sur un VPS (Ubuntu / Debian) avec un nom de domaine, HTTPS/WSS automatique (Let's Encrypt), et Twilio.

---

## 1. Prérequis sur votre VPS

1. Un VPS Ubuntu 22.04 ou 24.04 (chez OVH, Hetzner, DigitalOcean, AWS, etc.).
2. Un nom de domaine ou sous-domaine qui pointe vers l'adresse IP de votre VPS (ex: `voice.votredomaine.com` -> `IP_DU_VPS`).
3. Vos clés API dans votre fichier `.env` :
   - `GEMINI_API_KEY` (ou `GOOGLE_API_KEY`)
   - `DEEPGRAM_API_KEY`
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_FROM_NUMBER`
   - `RUSHDESK_API_URL` & `RUSHDESK_SHARED_SECRET`

---

## 2. Installation de Docker & Docker Compose sur le VPS

Connectez-vous à votre VPS en SSH :
```bash
ssh root@IP_DE_VOTRE_VPS
```

Mettez à jour le système et installez Docker :
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git nginx certbot python3-certbot-nginx

# Installation officielle de Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
```

---

## 3. Cloner et Lancer le Projet RushDesk Voice

```bash
# Clonez ou copiez votre code sur le serveur
git clone <URL_DE_VOTRE_DEPOT> /opt/rushdesk-voice
cd /opt/rushdesk-voice

# Créez votre fichier .env de production
cp .env.example .env
nano .env   # Remplissez vos vraies clés d'API (Deepgram, Gemini, Twilio)

# Démarrez le conteneur avec Docker Compose
docker compose up -d --build
```

Vérifiez que le conteneur tourne :
```bash
docker compose ps
docker compose logs -f
```

---

## 4. Configuration de Nginx (Reverse Proxy + WebSocket)

Créez le fichier de configuration Nginx pour votre domaine :
```bash
sudo nano /etc/nginx/sites-available/rushdesk-voice
```

Collez la configuration suivante (remplacez `voice.votredomaine.com` par votre vrai sous-domaine) :

```nginx
server {
    server_name voice.votredomaine.com;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts pour les longs appels téléphoniques (WebSocket)
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Activez le site et rechargez Nginx :
```bash
sudo ln -s /etc/nginx/sites-available/rushdesk-voice /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 5. Activer le SSL / HTTPS Gratuit (Let's Encrypt)

```bash
sudo certbot --nginx -d voice.votredomaine.com
```

Suivez les instructions à l'écran. Certbot va automatiquement ajouter le certificat SSL. Votre serveur est maintenant accessible en `https://voice.votredomaine.com` et `wss://voice.votredomaine.com` !

---

## 6. Configurer Twilio

Une fois votre serveur en ligne, allez sur la console Twilio (ou lancez le script automatique) :
1. Rendez-vous sur **Twilio Console** > **Phone Numbers** > **Manage** > **Active numbers**.
2. Cliquez sur votre numéro (`+33159480286`).
3. Dans la section **Voice Configuration** :
   - **A CALL COMES IN** : `Webhook`
   - **URL** : `https://voice.votredomaine.com/twiml`
   - **HTTP METHOD** : `HTTP POST`
4. Cliquez sur **Save configuration**.

🎉 **Votre IA Vocale est prête pour la production à grande échelle !**
