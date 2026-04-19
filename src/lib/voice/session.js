/**
 * Per-call voice session state.
 *
 * Why it exists
 * -------------
 * A phone call spans many HTTP turns on Vercel: each `<Gather>` posts back
 * to `/api/voice/turn`, which on a cold container knows nothing about the
 * conversation so far. We need to persist the transcript (and any in-flight
 * order metadata) between turns so the AI can reason about the whole call,
 * not just the latest utterance.
 *
 * Transport selection mirrors `orderEvents.js`:
 *
 *   - REDIS_URL present  → Redis KV with a 1-hour TTL (survives cold starts,
 *                          fans across a horizontally-scaled Vercel fleet).
 *   - REDIS_URL absent   → in-memory Map (fine for local dev + tests).
 *
 * Store contract (for DI in tests):
 *   - get(key):   Promise<object | null>
 *   - set(key, value): Promise<void>   (resets TTL)
 *   - delete(key): Promise<void>
 */
import Redis from 'ioredis';

export const VOICE_SESSION_TTL_SECONDS = 60 * 60; // 1 hour — longer than any realistic call
const KEY_PREFIX = 'rushdesk:voice:session:';

export function keyFor(callSid) {
  return `${KEY_PREFIX}${callSid}`;
}

/**
 * In-memory session store. Only suitable for a single Node process.
 * TTL is best-effort; the store clears the entry once the timer fires.
 */
export function createInMemorySessionStore({ ttlSeconds = VOICE_SESSION_TTL_SECONDS } = {}) {
  const map = new Map();
  const timers = new Map();
  const scheduleExpiry = (key) => {
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      map.delete(key);
      timers.delete(key);
    }, ttlSeconds * 1000);
    // Don't hold the Node event loop open just because a session exists.
    if (typeof t.unref === 'function') t.unref();
    timers.set(key, t);
  };
  return {
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
      scheduleExpiry(key);
    },
    async delete(key) {
      map.delete(key);
      const t = timers.get(key);
      if (t) {
        clearTimeout(t);
        timers.delete(key);
      }
    },
  };
}

/**
 * Redis-backed session store. Accepts any client with a string-based
 * `get/set/del` surface (ioredis-compatible) so tests can inject a stub.
 */
export function createRedisSessionStore(redis, { ttlSeconds = VOICE_SESSION_TTL_SECONDS } = {}) {
  if (!redis) throw new Error('createRedisSessionStore requires a redis client.');
  return {
    async get(key) {
      const raw = await redis.get(key);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // A malformed blob is as good as "no session" — don't let a stray
        // cache entry crash the turn handler.
        return null;
      }
    },
    async set(key, value) {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    },
    async delete(key) {
      await redis.del(key);
    },
  };
}

function selectDefaultStore() {
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
        console.error('[voiceSession] redis error:', err);
      });
      return createRedisSessionStore(client);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[voiceSession] falling back to in-memory store:', err);
    }
  }
  return createInMemorySessionStore();
}

// Reuse across hot reloads in dev + across warm-lambda invocations in prod.
const globalForStore = globalThis;
let store = globalForStore.__rushdeskVoiceSessionStore ?? selectDefaultStore();
if (process.env.NODE_ENV !== 'production') {
  globalForStore.__rushdeskVoiceSessionStore = store;
}

export function getVoiceSessionStore() {
  return store;
}

/** Override the default store — e.g. with an in-memory stub in tests. */
export function setVoiceSessionStore(custom) {
  store = custom;
  if (process.env.NODE_ENV !== 'production') {
    globalForStore.__rushdeskVoiceSessionStore = custom;
  }
}

/**
 * Shape of a voice session. Keep it small — this blob is re-fetched +
 * re-written every single conversational turn.
 *
 * @typedef {Object} VoiceSession
 * @property {string} callSid
 * @property {string} businessId
 * @property {string | null} from            Caller's E.164 number, if Twilio provided it.
 * @property {string | null} to              Called number.
 * @property {number} turnCount              Monotonic counter — used to cap runaway calls.
 * @property {Array<object>} messages        OpenAI chat-completion messages so far.
 * @property {string | null} placedOrderId   Set once `submit_order` succeeds.
 * @property {boolean} done                  Set once the agent is ready to hang up.
 * @property {string} createdAt              ISO timestamp.
 */

export function createEmptySession({ callSid, businessId, from, to }) {
  return {
    callSid,
    businessId,
    from: from ?? null,
    to: to ?? null,
    turnCount: 0,
    messages: [],
    placedOrderId: null,
    done: false,
    createdAt: new Date().toISOString(),
  };
}
