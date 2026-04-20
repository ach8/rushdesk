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

Callers dial the restaurant's number and converse with an [ElevenLabs Conversational AI](https://elevenlabs.io/docs/conversational-ai/overview) agent. ElevenLabs owns the entire realtime conversation (STT, LLM turns, TTS, barge-in). When the caller confirms their order, the agent invokes a **server tool** that POSTs the structured order to RushDesk, which pushes it to the kitchen dashboard in real time via the existing SSE stream.

### Agent setup (ElevenLabs dashboard)

1. Create a Conversational AI agent and give it the restaurant menu in its system prompt / knowledge base, including the `menu_item_id` for each item.
2. Add a **Webhook** server tool named `submit_order`:
   - Method `POST`, URL `https://<your-domain>/api/voice/submit-order`
   - Body parameters (JSON):
     - `conversation_id` → dynamic variable `{{system__conversation_id}}`
     - `caller_phone` → dynamic variable `{{system__caller_id}}` (telephony only)
     - `items` (array of `{ menu_item_id, quantity, notes }`) — collected by the LLM
     - `order_type` (`DINE_IN` | `TAKEAWAY` | `DELIVERY`)
     - `customer_name`, `order_notes` (optional)
3. Under **Webhooks**, copy the signing secret into `ELEVENLABS_WEBHOOK_SECRET`.

### Architecture

```
  Caller ──► ElevenLabs Agent (full-duplex voice, LLM turns, TTS)
                    │
                    └── submit_order server tool ──► POST /api/voice/submit-order
                                                          │
                                                          └──► createOrder()
                                                                    │
                                                                    └──► publishOrderEvent
                                                                              │
                                                                              └──► SSE → kitchen dashboard
```

RushDesk no longer runs any per-turn conversation logic — the only inbound surface is a single, stateless tool webhook. The endpoint **acks immediately** (`202 { ok: true, status: "accepted" }`) so the agent can confirm to the caller without dead air, then runs `createOrder` in the background via `waitUntil`. Consequently the agent does not receive a server-computed total or short code to read back; it should simply thank the caller and wrap up. Order creation re-uses the existing `createOrder` pipeline, which means:

- Totals are computed server-side from DB prices (the agent cannot negotiate).
- `conversation_id` is the idempotency key — webhook retries can't create duplicate orders.
- Menu items are re-validated against `{ businessId, available }` at submit time.
- The moment the order is created, the existing `orderEvents` broker fires → kitchen dashboard SSE streams pick it up within milliseconds.

### Security

- Every inbound request's `ElevenLabs-Signature` header is validated (HMAC-SHA256 over `<timestamp>.<raw_body>`, constant-time compare, 30-minute replay window). Requests without a valid signature are rejected with 403.
- Per-caller rate limit: each phone number may submit at most `VOICE_ORDER_DAILY_LIMIT` (default **2**) orders per rolling 24h. The next attempt returns `{ ok: false, code: "rate_limited" }` and the agent tells the caller they've hit the daily cap. Withheld / anonymous caller IDs are refused outright so hiding the number is not a bypass. Counters live in Redis (`REDIS_URL`) so the limit holds across the serverless fleet.
- `businessId` is resolved server-side; it is never read from the agent payload.
- The agent never sees a trusted price field and cannot smuggle menu items from other businesses — `createOrder` enforces that.
