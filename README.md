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
| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run test` | Run test suite |
| `npm run lint` | Run ESLint |
| `npm run format` | Check Prettier formatting |
