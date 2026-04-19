/**
 * Twilio webhook signature validation.
 *
 * Twilio signs every webhook request with HMAC-SHA1 over the exact URL
 * it invoked plus the alphabetically-sorted concatenation of (key+value)
 * for POST form parameters. Validating the signature is the ONLY thing
 * that keeps anonymous internet callers from POSTing fake TwiML events
 * at our webhooks and injecting orders into the kitchen. Treat it as
 * non-optional in production.
 *
 * See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Notes
 * -----
 *   - Twilio signs the URL AS IT CALLED IT. Behind a proxy, `request.url`
 *     may be an internal host. Callers should pass an explicit `url` they
 *     reconstruct from a trusted source (e.g. `PUBLIC_BASE_URL` + path).
 *   - Comparison is constant-time to prevent timing oracles.
 *   - Missing / empty `authToken` returns `{ ok: false }` rather than
 *     defaulting open. A misconfigured server should fail closed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compute the signature Twilio would have generated for a given webhook.
 *
 * @param {string} url — the full URL Twilio POSTed to, including query string
 * @param {Record<string,string>} params — form-encoded body parameters
 * @param {string} authToken — Twilio account auth token
 * @returns {string} base64-encoded HMAC-SHA1
 */
export function computeTwilioSignature(url, params, authToken) {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}

/**
 * Validate an inbound Twilio webhook.
 *
 * @param {{
 *   url: string,
 *   params: Record<string,string>,
 *   signatureHeader: string | null | undefined,
 *   authToken: string | undefined,
 * }} args
 * @returns {{ ok: true } | { ok: false, reason: 'missing-token' | 'missing-signature' | 'bad-signature' }}
 */
export function verifyTwilioSignature({ url, params, signatureHeader, authToken }) {
  if (typeof authToken !== 'string' || authToken.length === 0) {
    return { ok: false, reason: 'missing-token' };
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }

  const expected = computeTwilioSignature(url, params, authToken);
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}

/**
 * Reconstruct the canonical URL Twilio signed against.
 *
 * We prefer `PUBLIC_BASE_URL` when configured because Vercel's proxy can
 * rewrite the inbound Host / scheme and `request.url` may not match what
 * Twilio actually called. If `PUBLIC_BASE_URL` is absent we fall back to
 * the request URL as-is (fine for local dev with ngrok).
 */
export function canonicalWebhookUrl(request, { publicBaseUrl } = {}) {
  const url = new URL(request.url);
  if (publicBaseUrl && publicBaseUrl.length > 0) {
    const base = publicBaseUrl.replace(/\/$/, '');
    return `${base}${url.pathname}${url.search}`;
  }
  return `${url.origin}${url.pathname}${url.search}`;
}
