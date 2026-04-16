/**
 * Signed admin session cookie.
 *
 * Design
 * ------
 * The plain `ADMIN_API_TOKEN` never leaves the server. Browsers receive an
 * HMAC-SHA256-signed cookie whose key is the token itself, so:
 *
 *   - Forging a cookie requires the token (kept only on the server).
 *   - Rotating `ADMIN_API_TOKEN` atomically invalidates every live session.
 *   - The cookie is opaque to the client — no role/permission data can be
 *     tampered with without invalidating the signature.
 *
 * Cookie format: `<base64url(JSON payload)>.<base64url(HMAC)>`
 * Payload: `{ role: 'admin', iat: <unix-sec>, exp: <unix-sec> }`
 *
 * HttpOnly + Secure (in prod) + SameSite=Strict prevent JS access and
 * cross-site submission. The cookie is only scoped as broadly as needed.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'rd_admin_session';
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours

function getSigningSecret() {
  const secret = process.env.ADMIN_API_TOKEN;
  if (typeof secret !== 'string' || secret.length === 0) {
    return null;
  }
  return secret;
}

function sign(message, secret) {
  return createHmac('sha256', secret).update(message).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * Build a signed session cookie value. Throws if the signing secret
 * (ADMIN_API_TOKEN) isn't configured — callers should surface this as
 * a 500-class condition, not a 401.
 */
export function createAdminSessionValue({
  now = () => Date.now(),
  ttlSeconds = DEFAULT_SESSION_TTL_SECONDS,
} = {}) {
  const secret = getSigningSecret();
  if (!secret) {
    throw new Error('Cannot sign admin session: ADMIN_API_TOKEN is not configured');
  }

  const iat = Math.floor(now() / 1000);
  const exp = iat + ttlSeconds;
  const payload = JSON.stringify({ role: 'admin', iat, exp });
  const encoded = b64url(Buffer.from(payload, 'utf8'));
  const sig = b64url(sign(encoded, secret));
  return `${encoded}.${sig}`;
}

/**
 * Verify a cookie value. Never throws; returns a result object so callers
 * can distinguish "unauthenticated" (401) from "misconfigured" (500).
 *
 * @returns {{ ok: true, payload: { role: string, iat: number, exp: number } }
 *          | { ok: false, reason: 'missing' | 'malformed' | 'bad-signature' | 'expired' | 'not-configured' }}
 */
export function verifyAdminSessionValue(value, { now = () => Date.now() } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, reason: 'missing' };
  }

  const secret = getSigningSecret();
  if (!secret) {
    return { ok: false, reason: 'not-configured' };
  }

  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const encoded = value.slice(0, dot);
  const providedSig = value.slice(dot + 1);

  let providedBuf;
  try {
    providedBuf = fromB64url(providedSig);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const expectedBuf = sign(encoded, secret);
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let payload;
  try {
    payload = JSON.parse(fromB64url(encoded).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!payload || payload.role !== 'admin' || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.exp * 1000 <= now()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, payload };
}

export function adminSessionCookieOptions({ ttlSeconds = DEFAULT_SESSION_TTL_SECONDS } = {}) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: ttlSeconds,
  };
}

/** Constant-time string comparison for the one-time token login exchange. */
export function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
