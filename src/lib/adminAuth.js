/**
 * Thin wrapper around ADMIN_API_TOKEN validation.
 *
 * Used by internal API routes (e.g. cron-triggered cleanup) that
 * authenticate via a Bearer token header rather than a browser cookie.
 */
import { getEnv } from './env.js';
import { tokensMatch } from './adminSession.js';

/**
 * @param {string | null | undefined} header — the raw Authorization header value
 * @returns {{ ok: true } | { ok: false, error: string, status: number }}
 */
export function verifyAdminApiToken(header) {
  let token;
  try {
    token = getEnv().ADMIN_API_TOKEN;
  } catch {
    return { ok: false, error: 'Server configuration error.', status: 500 };
  }

  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return { ok: false, error: 'Missing or malformed Authorization header.', status: 401 };
  }

  const provided = header.slice('Bearer '.length);
  if (!tokensMatch(provided, token)) {
    return { ok: false, error: 'Invalid token.', status: 403 };
  }

  return { ok: true };
}
