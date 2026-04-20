/**
 * ElevenLabs webhook signature validation.
 *
 * ElevenLabs signs every outbound webhook (including Conversational AI
 * agent server-tool calls) with HMAC-SHA256 over `<timestamp>.<raw_body>`,
 * sent in the `ElevenLabs-Signature` header in the form:
 *
 *     t=<unix_seconds>,v0=<hex_sha256_hmac>
 *
 * Validating this is the ONLY thing that prevents anonymous internet
 * callers from POSTing fake order payloads at /api/voice/submit-order and
 * injecting orders into the kitchen. Treat as non-optional in production.
 *
 * See: https://elevenlabs.io/docs/product-guides/administration/webhooks
 *
 * Notes
 * -----
 *   - Comparison is constant-time to avoid timing oracles.
 *   - Timestamp is checked against a tolerance window (default 30 min,
 *     matching the ElevenLabs SDK) so a captured request cannot be
 *     replayed indefinitely.
 *   - Missing / empty `secret` returns `{ ok: false }` rather than
 *     defaulting open. A misconfigured server fails closed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 30 * 60;

/**
 * Parse an `ElevenLabs-Signature` header into `{ timestamp, signatures[] }`.
 * Multiple `v0=` entries are allowed (key rotation); any one matching is
 * sufficient.
 */
export function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v;
    else if (k === 'v0' && v) signatures.push(v);
  }
  if (!timestamp || signatures.length === 0) return null;
  return { timestamp, signatures };
}

export function computeElevenLabsSignature(timestamp, rawBody, secret) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Validate an inbound ElevenLabs webhook.
 *
 * @param {{
 *   rawBody: string,
 *   signatureHeader: string | null | undefined,
 *   secret: string | undefined,
 *   toleranceSeconds?: number,
 *   now?: () => number,
 * }} args
 * @returns {{ ok: true } | { ok: false, reason: 'missing-secret' | 'missing-signature' | 'malformed-signature' | 'stale-timestamp' | 'bad-signature' }}
 */
export function verifyElevenLabsSignature({
  rawBody,
  signatureHeader,
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  now = () => Math.floor(Date.now() / 1000),
}) {
  if (typeof secret !== 'string' || secret.length === 0) {
    return { ok: false, reason: 'missing-secret' };
  }
  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return { ok: false, reason: 'missing-signature' };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const ts = Number(parsed.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'malformed-signature' };
  }
  if (Math.abs(now() - ts) > toleranceSeconds) {
    return { ok: false, reason: 'stale-timestamp' };
  }

  const expected = computeElevenLabsSignature(parsed.timestamp, rawBody, secret);
  const match = parsed.signatures.some((sig) => safeEqual(sig, expected));
  if (!match) {
    return { ok: false, reason: 'bad-signature' };
  }
  return { ok: true };
}
