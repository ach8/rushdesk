import { describe, it, expect } from 'vitest';
import {
  normalizeCallerKey,
  createInMemoryRateLimiter,
  createRedisRateLimiter,
} from '@/lib/voice/rateLimit';

describe('normalizeCallerKey', () => {
  it('collapses formatting variants of the same number to one key', () => {
    const a = normalizeCallerKey('+1 (555) 123-4567');
    const b = normalizeCallerKey('+15551234567');
    const c = normalizeCallerKey(' 1-555-123-4567 ');
    expect(a).toBe('15551234567');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('returns null for withheld / anonymous markers so the route can refuse', () => {
    for (const v of ['anonymous', 'Restricted', 'UNKNOWN', 'unavailable', 'private']) {
      expect(normalizeCallerKey(v)).toBeNull();
    }
  });

  it('returns null for empty / non-string / too-short input', () => {
    expect(normalizeCallerKey('')).toBeNull();
    expect(normalizeCallerKey('   ')).toBeNull();
    expect(normalizeCallerKey('123')).toBeNull();
    expect(normalizeCallerKey(undefined)).toBeNull();
    expect(normalizeCallerKey(42)).toBeNull();
  });
});

describe('createInMemoryRateLimiter', () => {
  it('allows up to `limit` hits then denies the next within the window', async () => {
    const limiter = createInMemoryRateLimiter();
    const opts = { limit: 2, windowSeconds: 60 };
    expect((await limiter.hit('k', opts)).allowed).toBe(true);
    expect((await limiter.hit('k', opts)).allowed).toBe(true);
    const third = await limiter.hit('k', opts);
    expect(third.allowed).toBe(false);
    expect(third.current).toBe(3);
    expect(third.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('isolates buckets per key', async () => {
    const limiter = createInMemoryRateLimiter();
    const opts = { limit: 1, windowSeconds: 60 };
    expect((await limiter.hit('a', opts)).allowed).toBe(true);
    expect((await limiter.hit('b', opts)).allowed).toBe(true);
    expect((await limiter.hit('a', opts)).allowed).toBe(false);
  });
});

describe('createRedisRateLimiter', () => {
  // Minimal ioredis stub: incr / expire / ttl over an in-memory Map.
  function fakeRedis() {
    const store = new Map(); // key → { n, ttl }
    return {
      async incr(key) {
        const cur = store.get(key) ?? { n: 0, ttl: -1 };
        cur.n += 1;
        store.set(key, cur);
        return cur.n;
      },
      async expire(key, seconds) {
        const cur = store.get(key);
        if (cur) cur.ttl = seconds;
        return 1;
      },
      async ttl(key) {
        return store.get(key)?.ttl ?? -2;
      },
      _store: store,
    };
  }

  it('uses atomic INCR and only sets TTL on the first hit', async () => {
    const redis = fakeRedis();
    const limiter = createRedisRateLimiter(redis);
    const opts = { limit: 2, windowSeconds: 86400 };

    const r1 = await limiter.hit('15551234567', opts);
    expect(r1).toMatchObject({ allowed: true, current: 1 });
    // TTL was set on first hit.
    expect(redis._store.get('rushdesk:voice:ratelimit:15551234567').ttl).toBe(86400);

    const r2 = await limiter.hit('15551234567', opts);
    expect(r2).toMatchObject({ allowed: true, current: 2 });

    const r3 = await limiter.hit('15551234567', opts);
    expect(r3.allowed).toBe(false);
    expect(r3.current).toBe(3);
    expect(r3.retryAfterSeconds).toBe(86400);
  });

  it('re-applies a TTL if the key somehow has none (never lock out forever)', async () => {
    const redis = fakeRedis();
    // Seed a counter with no TTL (ttl = -1).
    redis._store.set('rushdesk:voice:ratelimit:x', { n: 5, ttl: -1 });
    const limiter = createRedisRateLimiter(redis);
    const r = await limiter.hit('x', { limit: 2, windowSeconds: 100 });
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(100);
    expect(redis._store.get('rushdesk:voice:ratelimit:x').ttl).toBe(100);
  });
});
