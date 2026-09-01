# Image Python 3.11 Slim pour production
FROM python:3.11-slim

# Définition des variables d'environnement
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8765

# Installation des dépendances système nécessaires (ffmpeg pour pydub)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copie et installation des dépendances Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copie du code source
COPY src/ ./src
COPY .env.example .

# Expose le port de l'application
EXPOSE 8765

# Commande de démarrage avec Uvicorn
CMD ["uvicorn", "src.server:app", "--host", "0.0.0.0", "--port", "8765", "--workers", "1"]
