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
