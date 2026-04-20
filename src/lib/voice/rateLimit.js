/**
 * Per-caller rate limiter for the voice submit-order webhook.
 *
 * Why it exists
 * -------------
 * Prank callers can dial the ElevenLabs agent repeatedly and place fake
 * orders to overwhelm the kitchen. We cap each caller (keyed by caller-ID
 * phone number) to N submit attempts per rolling 24-hour window. The Nth+1
 * attempt is denied with a structured `{ ok: false }` payload the agent
 * reads back to the caller.
 *
 * Transport selection mirrors `orderEvents.js`:
 *
 *   - REDIS_URL present  → atomic Redis INCR + EXPIRE. Correct on Vercel
 *                          and any horizontally-scaled deploy: every warm
 *                          container sees the same counter.
 *   - REDIS_URL absent   → in-memory Map. Fine for local dev + tests; NOT
 *                          safe across multiple containers.
 *
 * Limiter contract (DI-friendly so tests can inject a stub):
 *   hit(key, { limit, windowSeconds }):
 *     Promise<{ allowed: boolean, current: number, retryAfterSeconds: number }>
 *
 * Semantics
 * ---------
 *   - `hit` is an atomic increment-then-check. The first call in a window
 *     starts the TTL; subsequent calls do not extend it (fixed window from
 *     first attempt). This is race-safe under concurrent webhook retries.
 *   - We count *attempts*, not successful orders. A failed createOrder
 *     (e.g. unavailable item) still burns a slot — acceptable for an
 *     anti-abuse control, and avoids the TOCTOU window a post-success
 *     increment would introduce.
 */
import Redis from 'ioredis';

const KEY_PREFIX = 'rushdesk:voice:ratelimit:';

/**
 * Normalize a caller phone number into a stable rate-limit key.
 *
 * Telephony providers can deliver the same caller in slightly different
 * shapes ("+1 (555) 123-4567", "+15551234567"). We strip everything but
 * digits so all variants collapse to one bucket. Known anonymous markers
 * are treated as "no caller ID" so the route can refuse them outright —
 * otherwise hiding caller ID would be a trivial bypass.
 *
 * @returns {string | null} normalized key, or null when caller ID is
 *          unavailable / withheld.
 */
export function normalizeCallerKey(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lowered = trimmed.toLowerCase();
  if (
    lowered === 'anonymous' ||
    lowered === 'restricted' ||
    lowered === 'unknown' ||
    lowered === 'unavailable' ||
    lowered === 'private'
  ) {
    return null;
  }
  const digits = trimmed.replace(/\D+/g, '');
  // Reject obviously bogus / too-short strings ("0", "123") that some
  // carriers emit for withheld numbers.
  if (digits.length < 6) return null;
  return digits;
}

/**
 * In-memory fixed-window limiter. Single-process only.
 */
export function createInMemoryRateLimiter() {
  const buckets = new Map(); // key → { count, expiresAt }
  return {
    async hit(key, { limit, windowSeconds }) {
      const nowMs = Date.now();
      let bucket = buckets.get(key);
      if (!bucket || bucket.expiresAt <= nowMs) {
        bucket = { count: 0, expiresAt: nowMs + windowSeconds * 1000 };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.expiresAt - nowMs) / 1000));
      return {
        allowed: bucket.count <= limit,
        current: bucket.count,
        retryAfterSeconds,
      };
    },
  };
}

/**
 * Redis-backed fixed-window limiter. Accepts any ioredis-compatible client
 * so tests can inject a stub.
 *
 * INCR is atomic; we set the TTL only when the counter transitions 0→1 so
 * later hits in the same window cannot extend it.
 */
export function createRedisRateLimiter(redis) {
  if (!redis) throw new Error('createRedisRateLimiter requires a redis client.');
  return {
    async hit(key, { limit, windowSeconds }) {
      const redisKey = `${KEY_PREFIX}${key}`;
      const current = await redis.incr(redisKey);
      if (current === 1) {
        // NX-style: only the first hit in a window owns the TTL.
        await redis.expire(redisKey, windowSeconds);
      }
      let ttl = await redis.ttl(redisKey);
      if (ttl < 0) {
        // Belt-and-suspenders: a key without a TTL would never reset.
        // Re-apply the window so a stuck counter cannot lock a caller out
        // forever.
        await redis.expire(redisKey, windowSeconds);
        ttl = windowSeconds;
      }
      return {
        allowed: current <= limit,
        current,
        retryAfterSeconds: ttl,
      };
    },
  };
}

function selectDefaultLimiter() {
  const url = process.env.REDIS_URL;
  if (url && url.trim().length > 0) {
    try {
      const client = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        enableOfflineQueue: true,
      });
      client.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error('[voiceRateLimit] redis error:', err);
      });
      return createRedisRateLimiter(client);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[voiceRateLimit] falling back to in-memory limiter:', err);
    }
  }
  return createInMemoryRateLimiter();
}

// Reuse across hot reloads in dev + across warm-lambda invocations in prod
// so we hold at most one extra Redis connection per container.
const globalForLimiter = globalThis;
let limiter = globalForLimiter.__rushdeskVoiceRateLimiter ?? selectDefaultLimiter();
if (process.env.NODE_ENV !== 'production') {
  globalForLimiter.__rushdeskVoiceRateLimiter = limiter;
}

export function getVoiceRateLimiter() {
  return limiter;
}

/** Override the limiter — e.g. with an in-memory stub in tests. */
export function setVoiceRateLimiter(custom) {
  limiter = custom;
  if (process.env.NODE_ENV !== 'production') {
    globalForLimiter.__rushdeskVoiceRateLimiter = custom;
  }
}
