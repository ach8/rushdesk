import { z } from 'zod';

// Validate environment variables lazily so importing this module in tests
// does not require production secrets to be present.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().min(1).default('gpt-4o-mini'),
  // Shared secret for internal admin endpoints.
  // Required at least 32 chars so a weak token isn't deployed by accident.
  ADMIN_API_TOKEN: z.string().min(32),
  // Distributed pub/sub transport for the kitchen dashboard SSE stream.
  // Optional at the framework level: when unset we fall back to an
  // in-process broker (fine for local dev and single-node deploys).
  // REQUIRED in any horizontally-scaled deployment (e.g. Vercel) — a
  // container can only fan out an event to its own local subscribers
  // without it, so other kitchen screens would miss updates.
  REDIS_URL: z.string().url().optional(),
  // Shared secret used to validate inbound ElevenLabs webhook signatures
  // (HMAC-SHA256 over `<timestamp>.<raw_body>`). Without it any caller on
  // the internet could POST fake submit_order payloads and inject orders
  // into the kitchen. Treat as production-required.
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Anti-abuse: max submit_order attempts per caller phone number per
  // rolling 24h window. The (limit+1)th attempt is denied and the agent
  // tells the caller to stop. Keep this small — legit callers rarely
  // place more than one or two phone orders a day.
  VOICE_ORDER_DAILY_LIMIT: z.coerce.number().int().min(1).max(100).default(2),
});

let cached;

export function getEnv() {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// Test-only helper to reset the memoized env between test cases.
export function __resetEnvCache() {
  cached = undefined;
}
