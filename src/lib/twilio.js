/**
 * Twilio SMS delivery for advance-payment voice orders.
 *
 * This module is intentionally minimal — it exists only to send the
 * Stripe Checkout URL to the caller who just placed a voice order when
 * the business requires advance payment. No richer messaging flows live
 * here yet.
 *
 * Like `./stripe.js`, the Twilio client is lazy-built and all public
 * functions accept a `{ client }` dep so tests can pass a stub without
 * `vi.mock` and without a live Twilio account.
 */
import TwilioSDK from 'twilio';
import { getEnv } from './env.js';

let cachedClient;
function defaultClient() {
  if (cachedClient) return cachedClient;
  const env = getEnv();
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error('Twilio credentials are not configured. Cannot send SMS.');
  }
  cachedClient = TwilioSDK(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  return cachedClient;
}

// Test-only hook.
export function __resetTwilioClientCache() {
  cachedClient = undefined;
}

/**
 * Send the payment link to the caller's phone.
 *
 * The body is intentionally short — it has to fit comfortably in a
 * single SMS segment and be unambiguous to a caller who has just hung
 * up the phone. The link domain is hosted by Stripe (checkout.stripe.com),
 * so customers can verify authenticity.
 */
export async function sendPaymentSms(
  { toPhone, paymentUrl, shortCode },
  { client, fromNumber } = {},
) {
  if (!toPhone || !paymentUrl) {
    throw new Error('sendPaymentSms requires both toPhone and paymentUrl.');
  }
  const sender = client ?? defaultClient();
  const env = fromNumber ? { TWILIO_FROM_NUMBER: fromNumber } : getEnv();
  if (!env.TWILIO_FROM_NUMBER) {
    throw new Error('TWILIO_FROM_NUMBER is not configured.');
  }
  const codeHint = shortCode ? ` (#${shortCode})` : '';
  const body =
    `RushDesk: finalize your order${codeHint} by paying here — ${paymentUrl} ` +
    `The kitchen will start preparing your food as soon as payment is received.`;
  return sender.messages.create({
    to: toPhone,
    from: env.TWILIO_FROM_NUMBER,
    body,
  });
}

/**
 * Notify the customer that their order is ready for pickup.
 *
 * Sent automatically when kitchen staff transitions an order to READY.
 * The message is kept concise so it fits in a single SMS segment and is
 * immediately actionable: the short-code lets the customer identify
 * their order and the business name tells them where to go.
 */
export async function sendOrderReadySms(
  { toPhone, shortCode, businessName },
  { client, fromNumber } = {},
) {
  if (!toPhone) {
    throw new Error('sendOrderReadySms requires a toPhone number.');
  }
  const sender = client ?? defaultClient();
  const env = fromNumber ? { TWILIO_FROM_NUMBER: fromNumber } : getEnv();
  if (!env.TWILIO_FROM_NUMBER) {
    throw new Error('TWILIO_FROM_NUMBER is not configured.');
  }
  const codeHint = shortCode ? ` #${shortCode}` : '';
  const from = businessName ? ` at ${businessName}` : '';
  const body = `RushDesk: Your order${codeHint}${from} is ready for pickup! Head over whenever you're ready.`;
  return sender.messages.create({
    to: toPhone,
    from: env.TWILIO_FROM_NUMBER,
    body,
  });
}
