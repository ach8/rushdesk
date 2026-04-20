import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleSweepPayments } from '@/app/api/orders/sweep-payments/route';
import { __resetEnvCache } from '@/lib/env';

/**
 * `verifyAdminApiToken` reads `ADMIN_API_TOKEN` via `getEnv()` — so we
 * satisfy its env requirements here and reset the cache between tests.
 * Prisma / Stripe / Twilio are never touched because we inject a stub
 * `sweep` via deps.
 */
const VALID_TOKEN = 'x'.repeat(40);
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://test/test';
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.ADMIN_API_TOKEN = VALID_TOKEN;
  __resetEnvCache();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  __resetEnvCache();
});

function request({ auth, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = auth;
  return new Request('https://rushdesk.test/api/orders/sweep-payments', {
    method: 'POST',
    headers,
    body: body ?? '',
  });
}

describe('POST /api/orders/sweep-payments', () => {
  it('rejects unauthenticated calls with 401 and never runs the sweep', async () => {
    const sweep = vi.fn();
    const res = await handleSweepPayments(request(), { sweep });
    expect(res.status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with 403 and never runs the sweep', async () => {
    const sweep = vi.fn();
    const res = await handleSweepPayments(
      request({ auth: 'Bearer wrong-token-that-is-long-enough-abcdefghij' }),
      { sweep },
    );
    expect(res.status).toBe(403);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('runs the sweep with the configured default TTL when no body is provided', async () => {
    const sweep = vi.fn(async () => ({ cancelled: 2 }));
    const res = await handleSweepPayments(request({ auth: `Bearer ${VALID_TOKEN}` }), {
      sweep,
      env: { VOICE_PAYMENT_SESSION_TTL_MINUTES: 30 },
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toMatchObject({ ok: true, cancelled: 2, olderThanMinutes: 30 });
    expect(sweep).toHaveBeenCalledWith({ olderThanMinutes: 30 });
  });

  it('honours an explicit olderThanMinutes override, clamped to [1, 1440]', async () => {
    const sweep = vi.fn(async () => ({ cancelled: 0 }));
    await handleSweepPayments(
      request({ auth: `Bearer ${VALID_TOKEN}`, body: JSON.stringify({ olderThanMinutes: 0 }) }),
      { sweep, env: { VOICE_PAYMENT_SESSION_TTL_MINUTES: 30 } },
    );
    // Clamped up to 1 — a runaway caller passing 0 cannot nuke every
    // in-flight order.
    expect(sweep).toHaveBeenCalledWith({ olderThanMinutes: 1 });
  });

  it('returns 500 when the sweep throws, without leaking internals', async () => {
    const sweep = vi.fn(async () => {
      throw new Error('DB dead');
    });
    const res = await handleSweepPayments(request({ auth: `Bearer ${VALID_TOKEN}` }), {
      sweep,
      env: { VOICE_PAYMENT_SESSION_TTL_MINUTES: 30 },
    });
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload.error).toBe('Sweep failed.');
  });
});
