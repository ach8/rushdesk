# RushDesk

AI-powered order and reservation management platform for restaurants, fast-food chains, and hotels.

## Features (Planned)

- **AI Voice Assistant** — Takes phone orders via conversational AI, extracts structured order data
- **Kitchen Dashboard** — Real-time order board with status tracking (Pending → Preparing → Ready → Delivered)
- **Reservation Management** — Table/room booking with calendar view
- **Menu Management** — CRUD for menu items with pricing and availability

## Tech Stack

- **Framework**: Next.js 14+ (App Router)
- **Language**: JavaScript (ES6+)
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL) + Prisma ORM
- **AI**: OpenAI API
- **Real-time**: Server-Sent Events (SSE)
- **Testing**: Vitest + React Testing Library

## Getting Started

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env.local

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start dev server
npm run dev
```

## Scripts

| Command          | Description               |
| ---------------- | ------------------------- |
| `npm run dev`    | Start development server  |
| `npm run build`  | Build for production      |
| `npm run test`   | Run test suite            |
| `npm run lint`   | Run ESLint                |
| `npm run format` | Check Prettier formatting |

## AI Voice Receptionist

Callers dial the restaurant's Twilio number and converse with an OpenAI-powered agent that takes orders. Each successful order is pushed to the kitchen dashboard in real time via the existing SSE stream.

### Webhooks

Configure these on your Twilio phone number:

| Twilio Setting                               | URL                                        |
| -------------------------------------------- | ------------------------------------------ |
| **A call comes in** — Webhook, HTTP POST     | `https://<your-domain>/api/voice/incoming` |
| **Call status changes** — Webhook, HTTP POST | `https://<your-domain>/api/voice/status`   |

`/api/voice/turn` is referenced internally by the TwiML returned from `/incoming` — it does not need to be configured at Twilio.

### Architecture

```
  Caller ──► Twilio ──► /api/voice/incoming  (greeting + <Gather input="speech">)
                          │
                          ├──► /api/voice/turn   (SpeechResult → OpenAI → TwiML reply)
                          │       │
                          │       └──► submit_order tool → createOrder()
                          │                                      │
                          │                                      └──► publishOrderEvent
                          │                                                │
                          │                                                └──► SSE → kitchen dashboard
                          │
                          └──► /api/voice/status (cleanup on hangup)
```

Every turn is a short-lived HTTP request — Vercel-native. Per-call transcript is persisted in Redis (keyed by `CallSid`) so any warm container can resume the conversation. Order creation re-uses the existing `createOrder` pipeline, which means:

- Totals are computed server-side from DB prices (the AI cannot negotiate).
- `CallSid` is the idempotency key — Twilio retries can't create duplicate orders.
- Menu items are re-validated against `{ businessId, available }` at submit time.
- The moment the order is created, the existing `orderEvents` broker fires → kitchen dashboard SSE streams pick it up within milliseconds.

### Latency / realtime note

This implementation uses Twilio's speech recognition + neural TTS as the voice layer, with OpenAI Chat Completions per turn. End-to-end per-turn latency is typically 1–2s (speech detection + OpenAI + TTS playback). For sub-second conversational feel you'd bridge raw audio between Twilio Media Streams and the OpenAI Realtime API over a persistent WebSocket — that path requires a long-lived compute host outside Vercel's serverless functions. The tool contract (`submit_order`, etc.) is transport-agnostic, so upgrading later only touches `src/app/api/voice/*`.

### Security

- Every inbound webhook's `X-Twilio-Signature` is validated (HMAC-SHA1, constant-time compare). Requests without a valid signature are rejected with 403.
- The signed URL is reconstructed from `PUBLIC_BASE_URL` + path — set this env var to the exact URL configured in Twilio so a proxy-rewritten `Host` header can't break signature validation.
- The AI never sees a trusted price field and cannot smuggle menu items from other businesses — `createOrder` enforces that.
