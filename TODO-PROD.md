# 🚨 TODO AVANT MISE EN PRODUCTION (PROD) 🚨

Ce fichier liste tous les contournements (bypasses) et données de test mis en place durant la phase de développement avec l'IA. **Ils doivent impérativement être corrigés/supprimés avant d'accepter de vrais clients.**

## 1. Sécurité & Anti-Spam
- [ ] **Supprimer le contournement "None" pour le Caller ID :**
  - **Fichier :** `src/lib/voice/rateLimit.js`
  - **Action :** Supprimer les lignes qui transforment `lowered === 'none'` en `0000000000`. Cela empêchera les appels anonymes ou web de spammer la cuisine.

- [ ] **Supprimer le contournement de validation Zod pour le Caller ID :**
  - **Fichier :** `src/app/api/voice/submit-order/route.js`
  - **Action :** Supprimer `callerKey || '0000000000'` dans la création du contexte (`ctx: { ..., callerPhone: callerKey || '0000000000' }`) pour remettre `callerPhone` normal. Cela obligera ElevenLabs à fournir un vrai numéro de téléphone.

- [ ] **Rétablir l'exécution en arrière-plan (Performance Vercel) :**
  - **Fichier :** `src/app/api/voice/submit-order/route.js`
  - **Action :** Actuellement, la création de commande est faite avec un `await` bloquant pour faciliter le debug. Remettre la structure d'origine avec `runAfterResponse` (et s'assurer que `@vercel/functions` `waitUntil` fonctionne bien) pour éviter les silences au téléphone si Redis met trop de temps à répondre.

- [ ] **Vérifier le Secret ElevenLabs (Signature) :**
  - **Fichier :** `src/app/api/voice/submit-order/route.js`
  - **Action :** Supprimer le commentaire (décommenter) la ligne `return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });` pour réactiver la vérification de la signature ElevenLabs. Sans ça, n'importe qui peut forcer des commandes !
  - **Action 2 :** S'assurer que la variable d'environnement `ELEVENLABS_WEBHOOK_SECRET` sur Vercel correspond exactement au secret de production de l'Agent Vocal final.

- [ ] **Réactiver la Sécurité Anti-Spam (Rate Limiter) :**
  - **Fichier :** `src/app/api/voice/submit-order/route.js`
  - **Action :** Supprimer le bloc `// [TESTING BYPASS]` qui force `gate = { allowed: true };` et décommenter le vrai bloc `return NextResponse.json({ ok: false, code: 'rate_limit_unavailable' ... });`.
  
- [ ] **Vérifier la connexion Redis (Upstash) :**
  - **Action :** S'assurer que l'URL `REDIS_URL` dans les variables d'environnement Vercel est parfaitement exacte (sans espace, commence bien par `rediss://`). C'est indispensable pour le Rate Limiter et pour que la cuisine reçoive les commandes en direct (sans devoir actualiser la page).

## 2. Nettoyage des Données de Test
- [ ] **Supprimer les fausses commandes :**
  - **Action :** Vider la base de données des commandes générées par le script `simulate-orders.js` ou les tests depuis l'interface web.
  - **Script de nettoyage (optionnel) :** Créer un script pour purger la table `Order` et `OrderItem`.

- [ ] **Nettoyer le Menu :**
  - **Action :** Supprimer les produits de test (ex: "Burger Test", "Menu Double Cheese" générés par script) et ajouter le VRAI menu du restaurant via le tableau de bord (`/admin/menu`).

## 3. Architecture & Multi-Tenancy (Si mode SaaS activé)
- [ ] **Passer la résolution du Restaurant en mode dynamique :**
  - **Fichier concerné :** `src/lib/orders.js` (`resolveActiveBusinessId()`)
  - **Action :** Actuellement, le système prend "le premier restaurant trouvé" dans la base de données. Il faudra lire le `businessId` depuis le cookie de session (pour l'admin) et depuis l'URL/Header (pour ElevenLabs) afin que chaque restaurant soit complètement isolé.

## 4. Côté ElevenLabs (L'Agent Vocal)
- [ ] **Lier un vrai numéro de téléphone (Twilio) :**
  - **Action :** Pour le moment, l'agent est testé via le widget web. En production, il faudra lier un numéro de téléphone réel (ex: Twilio) pour que les clients puissent appeler, et pour que le vrai `caller_id` soit transmis à Vercel.
- [ ] **Mettre à jour le System Prompt :**
  - **Action :** Remplacer le menu de test écrit en dur dans les instructions de l'Agent par le vrai menu de votre restaurant avec les vrais identifiants (IDs) issus de la base de données de production.

## 5. Fichiers de script temporaires
- [ ] **Supprimer les scripts locaux :**
  - Supprimer `simulate-orders.js`
  - Supprimer `seed-menu.js`
  - Supprimer `test-redis.js`
  - Supprimer `get-id.js`
  - Supprimer `get-id.js`
