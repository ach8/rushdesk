/**
 * POST /api/stripe/webhook — lifecycle events for advance-payment voice
 * orders.
 *
 * Flow
 * ----
 * 1. Read the RAW request body and verify the `Stripe-Signature` header
 *    against `STRIPE_WEBHOOK_SECRET`. Anything failing verification is
 *    rejected with 400 and nothing touches the database. This is the
 *    only thing that prevents a public caller from flipping orders to
 *    PAID.
 * 2. Dispatch on `event.type`:
 *      - `checkout.session.completed` → find the order by
 *        `stripeSessionId`, idempotently set `paymentStatus = PAID`, and
 *        fire `publishOrderEvent('order.created')`. This is the single
 *        moment the kitchen dashboard learns about an advance-payment
 *        order; no other code path publishes it.
 *      - `checkout.session.expired` → set `paymentStatus = EXPIRED` and
 *        `status = CANCELLED`. We do NOT publish — kitchen never saw
 *        the order and never needs to.
 *      - Any other event → 200 no-op. Stripe retries on non-2xx so we
 *        explicitly don't error on unrelated events.
 * 3. Idempotency: every DB write is a conditional `updateMany` on the
 *    current (non-terminal) paymentStatus, so a duplicated webhook is a
 *    zero-row update and the publish runs at most once per session.
 *
 * The exported `handleStripeWebhook(request, deps)` mirrors the shape of
 * `handleSubmitOrder` so tests can inject stubbed Stripe + Prisma +
 * publisher and exercise the full pipeline.
 */
import { NextResponse } from 'next/server';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { publishOrderEvent as defaultPublish } from '@/lib/orderEvents';
import { serializeOrder } from '@/lib/orders';
import { verifyWebhookEvent } from '@/lib/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function handleStripeWebhook(request, deps = {}) {
  const {
    prisma = defaultPrisma,
    verifyEvent = verifyWebhookEvent,
    publishOrderEvent = defaultPublish,
  } = deps;

  const rawBody = await request.text();
  const signatureHeader = request.headers.get('stripe-signature');

  let event;
  try {
    event = verifyEvent({ rawBody, signatureHeader });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stripe.webhook] signature verification failed', err?.message ?? err);
    return NextResponse.json({ error: 'Invalid signature.' }, { status: 400 });
  }

  const session = event?.data?.object;
  const sessionId = session?.id;
  if (!sessionId) {
    return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      // Conditional update so a replay is a no-op — only rows still
      // marked PENDING advance to PAID. `updateMany` returns a count
      // rather than throwing on zero matches.
      const result = await prisma.order.updateMany({
        where: { stripeSessionId: sessionId, paymentStatus: 'PENDING' },
        data: { paymentStatus: 'PAID' },
      });

      if (result.count === 0) {
        // Either the order is already PAID (duplicate webhook) or the
        // session id is unknown (shouldn't happen post-verification).
        // Either way, nothing to publish.
        return NextResponse.json({ ok: true, alreadyProcessed: true }, { status: 200 });
      }

      // Hydrate the freshly-paid order and fan it out to the kitchen.
      const order = await prisma.order.findUnique({
        where: { stripeSessionId: sessionId },
        include: { items: { include: { menuItem: true } } },
      });
      if (order) {
        const serialized = serializeOrder(order);
        publishOrderEvent({
          type: 'order.created',
          businessId: serialized.businessId,
          order: serialized,
        });
      }
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    case 'checkout.session.expired': {
      // Auto-cancel: order never reached the kitchen and the caller
      // never paid. Same conditional-update idempotency guard as above.
      await prisma.order.updateMany({
        where: { stripeSessionId: sessionId, paymentStatus: 'PENDING' },
        data: { paymentStatus: 'EXPIRED', status: 'CANCELLED' },
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    default:
      // Stripe retries non-2xx indefinitely — don't reject unrelated
      // events, just acknowledge them.
      return NextResponse.json({ ok: true, ignored: true }, { status: 200 });
  }
}

export async function POST(request) {
  return handleStripeWebhook(request);
}
