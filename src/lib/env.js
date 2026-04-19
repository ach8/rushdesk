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
  // The same Redis is used for voice-call session state so a follow-up
  // turn hitting a cold container can recover the in-flight conversation.
  REDIS_URL: z.string().url().optional(),
  // Twilio credentials for the AI voice receptionist.
  // AUTH_TOKEN is used to validate inbound webhook signatures — without
  // it any caller on the internet could inject fake orders by POSTing
  // TwiML webhook payloads. Treat as production-required.
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  // Public origin Twilio calls back into (e.g. https://rushdesk.vercel.app).
  // Used to reconstruct the canonical URL that Twilio signs. If a request
  // hits us via a different host (local tunnel, preview deploy), set this
  // to match the configured Twilio Voice webhook URL exactly.
  PUBLIC_BASE_URL: z.string().url().optional(),
  // Neural voice id Twilio reads responses with. Amazon Polly neural
  // voices deliver the best quality / broadest availability pair.
  TWILIO_VOICE: z.string().min(1).default('Polly.Joanna-Neural'),
  // Spoken language for TTS + speech recognition.
  TWILIO_LANGUAGE: z.string().min(2).default('en-US'),
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
