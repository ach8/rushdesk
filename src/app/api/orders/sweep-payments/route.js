/**
 * POST /api/orders/sweep-payments — cancel stale PENDING-payment orders.
 *
 * Purpose: a kitchen-hygiene cron target. Callers who agree to an order
 * with the AI receptionist, receive the Stripe SMS, and then abandon the
 * checkout page would otherwise leave `Order.paymentStatus = PENDING`
 * rows sitting around until Stripe's `session.expired` webhook fires.
 * This endpoint is a belt-and-suspenders companion to that webhook:
 *   - If Stripe's expired webhook fired, there's nothing to sweep.
 *   - If it didn't (delivery outage, dropped signature, etc.) or hasn't
 *     yet (Stripe's minimum session TTL is 30 min), this endpoint
 *     cancels anything that's been PENDING longer than the configured
 *     window.
 *
 * Auth: Bearer ADMIN_API_TOKEN — same as POST /api/orders. This is a
 * server-to-server endpoint (cron, ops tooling) and is NOT exposed to
 * browser users.
 *
 * Recommended schedule: every 5–15 minutes. The query is a single
 * indexed `updateMany`, so there's no real cost to running often.
 *
 * Request body (optional JSON):
 *   { "olderThanMinutes": number }  - overrides the default TTL window.
 *
 * Response: `{ ok: true, cancelled: <number> }`.
 */
import { NextResponse } from 'next/server';
import { verifyAdminApiToken } from '@/lib/adminAuth';
import { sweepExpiredPendingOrders } from '@/lib/orders';
import { getEnv } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function handleSweepPayments(request, deps = {}) {
  const { sweep = sweepExpiredPendingOrders, env } = deps;

  const auth = verifyAdminApiToken(request.headers.get('authorization'));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  // Body is optional — an empty POST uses the configured default.
  let body = {};
  const text = await request.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
    }
  }

  const defaultTtl = (
    env ??
    (() => {
      try {
        return getEnv();
      } catch {
        return { VOICE_PAYMENT_SESSION_TTL_MINUTES: 30 };
      }
    })()
  ).VOICE_PAYMENT_SESSION_TTL_MINUTES;

  // Accept an override but clamp it: a runaway caller passing
  // `olderThanMinutes: 0` would otherwise nuke every in-flight order.
  let olderThanMinutes = defaultTtl;
  if (typeof body.olderThanMinutes === 'number' && Number.isFinite(body.olderThanMinutes)) {
    olderThanMinutes = Math.min(Math.max(Math.round(body.olderThanMinutes), 1), 24 * 60);
  }

  try {
    const { cancelled } = await sweep({ olderThanMinutes });
    return NextResponse.json({ ok: true, cancelled, olderThanMinutes }, { status: 200 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[orders.sweep-payments] sweep failed', err);
    return NextResponse.json({ error: 'Sweep failed.' }, { status: 500 });
  }
}

export async function POST(request) {
  return handleSweepPayments(request);
}
