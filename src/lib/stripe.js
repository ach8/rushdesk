/**
 * Stripe integration for voice-order advance payments.
 *
 * When a business has `requireVoicePaymentUpfront` enabled, a voice order
 * is NOT published to the kitchen on creation. Instead we build a hosted
 * Stripe Checkout Session whose URL is SMSed to the caller (see
 * `./twilio.js`). The session's webhook drives the rest of the lifecycle:
 *
 *   checkout.session.completed  →  Order.paymentStatus = PAID
 *                                  publishOrderEvent('order.created')
 *   checkout.session.expired    →  Order.paymentStatus = EXPIRED
 *                                  Order.status        = CANCELLED
 *
 * Design choices
 * --------------
 *   - We build `line_items` from the already-persisted `OrderItem` rows.
 *     Their `unitPrice` is the server-side snapshot captured at order
 *     creation (see CLAUDE.md data-integrity rules), so the price shown
 *     on the Stripe page cannot be tampered with by anything that ran
 *     after `createOrder`.
 *   - `expires_at` is set to 24h from now (the Stripe maximum). We lean on
 *     Stripe to emit `checkout.session.expired` — no custom scheduler.
 *   - `metadata.orderId` and `metadata.businessId` are duplicated in the
 *     session so the webhook can cross-check the `stripeSessionId` lookup
 *     (defense in depth — a corrupted session id column won't let a
 *     webhook flip the wrong order).
 *   - Every function takes a `{ stripe }` dep so tests can pass a stub
 *     without `vi.mock` and without a live Stripe account.
 */
import StripeSDK from 'stripe';
import { getEnv } from './env.js';

// Stripe client is lazy-constructed so importing this module in a unit
// test (where STRIPE_SECRET_KEY is unset) does not throw.
let cachedClient;
function defaultStripe() {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured. Cannot create Checkout Sessions.');
  }
  cachedClient = new StripeSDK(env.STRIPE_SECRET_KEY, {
    // Pin the API version so an upstream default bump cannot silently
    // change request/response shapes in production.
    apiVersion: '2024-06-20',
  });
  return cachedClient;
}

// Test-only hook — resets the memoized client.
export function __resetStripeClientCache() {
  cachedClient = undefined;
}

/**
 * Stripe's own hard bounds on `expires_at`: minimum 30 min, maximum 24h.
 * We clamp to this range regardless of what the env var says.
 */
const MIN_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 24 * 60;

/**
 * Create a Stripe Checkout Session for a just-created Order. `order` is
 * the serialized shape returned by `serializeOrder` — it carries `items`
 * with `menuItemName`, `quantity`, and `unitPrice` (dollars).
 *
 * Returns `{ id, url }` ready to persist on the Order and send via SMS.
 */
export async function createSessionForOrder(order, { stripe, appBaseUrl, ttlMinutes } = {}) {
  const client = stripe ?? defaultStripe();
  const env = appBaseUrl ? { APP_BASE_URL: appBaseUrl } : getEnv();
  if (!env.APP_BASE_URL) {
    throw new Error('APP_BASE_URL is not configured. Cannot build Checkout success/cancel URLs.');
  }
  const origin = env.APP_BASE_URL.replace(/\/+$/, '');

  // Clamp TTL into Stripe's supported range. Prefer the caller-supplied
  // override, then env, then the default (30 min) — keeping abandoned
  // orders around only long enough for a real customer to return and
  // pay, not long enough to clog the kitchen's mental queue.
  const rawTtl =
    ttlMinutes ??
    (typeof env.VOICE_PAYMENT_SESSION_TTL_MINUTES === 'number'
      ? env.VOICE_PAYMENT_SESSION_TTL_MINUTES
      : MIN_TTL_MINUTES);
  const ttlSeconds = Math.min(Math.max(rawTtl, MIN_TTL_MINUTES), MAX_TTL_MINUTES) * 60;

  const lineItems = order.items.map((item) => ({
    quantity: item.quantity,
    price_data: {
      currency: 'usd',
      unit_amount: Math.round(Number(item.unitPrice) * 100),
      product_data: {
        name: item.menuItemName || 'Menu item',
        // Per-line special instructions become a Stripe line description
        // so the caller sees "no onions" on the checkout page.
        ...(item.notes ? { description: item.notes } : {}),
      },
    },
  }));

  const session = await client.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: lineItems,
    expires_at: Math.floor(Date.now() / 1000) + ttlSeconds,
    // These pages are static — RushDesk doesn't need a bespoke post-payment
    // landing page; Stripe's own receipt + our SMS/kitchen signal cover it.
    success_url: `${origin}/pay/success?order=${encodeURIComponent(order.id)}`,
    cancel_url: `${origin}/pay/cancel?order=${encodeURIComponent(order.id)}`,
    metadata: {
      orderId: order.id,
      businessId: order.businessId,
    },
  });

  if (!session?.id || !session?.url) {
    throw new Error('Stripe Checkout Session creation returned no id/url.');
  }
  return { id: session.id, url: session.url };
}

/**
 * Verify an inbound webhook against `STRIPE_WEBHOOK_SECRET`. Returns the
 * parsed event on success; throws otherwise. Kept as a thin wrapper so
 * the route handler can stay declarative and tests can stub this out.
 */
export function verifyWebhookEvent({ rawBody, signatureHeader, stripe, secret } = {}) {
  const client = stripe ?? defaultStripe();
  const env = secret ? { STRIPE_WEBHOOK_SECRET: secret } : getEnv();
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not configured.');
  }
  return client.webhooks.constructEvent(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
}
