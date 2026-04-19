# RushDesk — AI-Powered Order & Reservation Management for Local Businesses

## Project Overview

RushDesk is a Full-Stack JavaScript SaaS platform designed for restaurants, fast-food chains, and hotels to manage customer orders and reservations through an AI-powered voice assistant. The AI receptionist takes phone orders, converts spoken requests into structured data, and pushes them to a real-time kitchen dashboard where staff can track and manage order status.

The platform is built as a modular companion to [LocalBoost](https://github.com/ach8/localboost) — sharing the same technology stack and architectural patterns — so the two can be merged into a unified SaaS suite for local businesses.

## Architecture

- **Framework**: Next.js 14+ (App Router)
- **Language**: JavaScript (ES6+)
- **Styling**: Tailwind CSS
- **Database**: Supabase (PostgreSQL) + Prisma ORM
- **AI**: OpenAI API for voice-to-order conversation, menu understanding, and structured order extraction
- **Real-time**: Server-Sent Events (SSE) for kitchen dashboard live updates

## Development Rules

### Git Workflow

- Always create a feature branch before making changes. Never commit directly to `main`.
- Branch naming convention: `feat/<feature-name>`, `fix/<bug-name>`, `refactor/<scope>`
- Write meaningful commit messages following Conventional Commits format.
- Do NOT force push or use `--no-verify` under any circumstances.
- Do NOT amend commits that have already been pushed.

### Next.js & JavaScript Conventions

- Use the Next.js App Router (`src/app/`). Do not use the `pages/` directory.
- All API routes must be implemented elegantly inside `src/app/api/`.
- Use Server Actions (`"use server"`) where appropriate, but never place business logic directly inside React components.
- Components must be functional components with hooks.
- Extensively use modern ES6+ features (destructuring, async/await).
- Environment variables must be validated dynamically before usage, not scattered raw `process.env` calls throughout components.
- Prisma schemas go in `prisma/schema.prisma`.

### Data Integrity Rules (CRITICAL)

- The `totalAmount` of an Order MUST always be computed server-side from `SUM(OrderItem.unitPrice * OrderItem.quantity)`. Never trust a client-submitted total.
- `OrderItem.unitPrice` MUST be a snapshot (copy) of `MenuItem.price` captured at order-creation time. It must never be a live reference to the menu — prices can change after an order is placed.
- All data-access functions in `src/lib/` MUST accept an optional `deps` parameter (e.g. `{ prisma }`) for dependency injection, making them unit-testable without a live database.
- All mutations (order creation, status updates) MUST be validated through a dedicated Zod schema in `src/lib/orderValidation.js`. No ad-hoc inline validation.

### Styling

- Use Tailwind CSS utility classes exclusively. Avoid writing custom CSS unless absolutely necessary.
- Follow mobile-first design principles.

### Testing

- Use Vitest and React Testing Library. Tests go in `src/__tests__/`.
- External API calls (OpenAI, Twilio, Google, Stripe) must ALWAYS be mocked in tests. Never make real API calls during test suite execution.
- Run `npm run test` before considering any feature task complete.

### Security

- Never log or print API keys, tokens, or passwords to the console.
- Never commit `.env` or `.env.local` files. Use `.env.example` with placeholder values.
- All user-facing inputs must be sanitized. Server-side validation is mandatory for all mutations.

### Code Quality

- Run `npx eslint .` and `npx prettier --check .` before committing changes.
- Do not disable linter rules inline unless absolutely necessary, and always add an explanatory comment if you do.

### Voice Receptionist Flow (CRITICAL)

- Twilio webhooks live under `src/app/api/voice/`. Every inbound webhook MUST validate `X-Twilio-Signature` before doing anything else — `verifyTwilioSignature` is the only thing between anonymous internet callers and fake orders in the kitchen.
- The signed URL is reconstructed via `canonicalWebhookUrl(request, { publicBaseUrl })`. Do NOT rely on `request.url` alone — Vercel / proxies can rewrite the Host header.
- `CallSid` MUST be passed as the `idempotencyKey` to `createOrder` so Twilio retries cannot create duplicate orders. `src/lib/voice/tools.js::normalizeSubmitOrderArgs` already does this — do not bypass it.
- The AI must NEVER be able to set `customerPhone` from tool arguments. The phone comes from Twilio's `From` param and is captured into the session at call start.
- Per-call session state (transcript, turn count, placed order id) lives in `src/lib/voice/session.js` — Redis when `REDIS_URL` is set, in-memory Map otherwise. The same REDIS_URL powers the kitchen SSE broker; the two don't share clients but do share the env var.
- A successful `submit_order` tool call automatically flows through `createOrder` → `publishOrderEvent` → kitchen dashboard SSE. No extra wiring needed.

### Communication & Agentic Behavior

- If a task involves deleting files, dropping database tables, applying unsafe Prisma migrations, or modifying shared configuration, ask for explicit confirmation before proceeding.
- If requirements are ambiguous, ask clarifying questions rather than making assumptions about the business logic.
- After completing a task, provide a summary of what was done and which tests were executed.
