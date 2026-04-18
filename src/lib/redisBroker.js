/**
 * Redis-backed implementation of the order-event broker contract.
 *
 * Why Redis Pub/Sub (Upstash on Vercel)
 * -------------------------------------
 *   - Vercel runs multiple horizontally-scaled lambda instances behind a
 *     load balancer. An in-process EventEmitter only fans out within a
 *     single container, so an order created on container A would never
 *     reach an SSE subscriber pinned to container B.
 *   - Redis Pub/Sub is the smallest possible distributed transport that
 *     matches our `{ publish, subscribe }` broker contract. Swap the
 *     broker at boot and every existing caller keeps working.
 *   - We deliberately keep pub/sub OFF the Postgres connection pool.
 *     Postgres LISTEN/NOTIFY would hold one long-lived connection per
 *     SSE subscriber, which in a serverless fleet exhausts the pool
 *     quickly. Upstash's connection model is designed for bursty
 *     serverless traffic and does not interact with our DB pool at all.
 *
 * Connection model (important for serverless)
 * -------------------------------------------
 *   - Exactly TWO Redis connections per warm container:
 *       * `pub` — used by every POST/PATCH invocation to publish events.
 *       * `sub` — used by every active SSE connection on this container;
 *                 Redis SUBSCRIBE monopolizes the connection, so it must
 *                 be separate from `pub`.
 *   - Local fan-out via an `EventEmitter`: if 10 browsers are connected
 *     to the same container watching the same business, the container
 *     holds ONE Redis subscription for that business, not ten. Each
 *     Redis message is dispatched to all local handlers in memory.
 *   - Reference-counted (un)subscribe: the container only calls Redis
 *     SUBSCRIBE on the first local listener and UNSUBSCRIBE on the last
 *     to disconnect. Stale subscriptions cannot leak.
 *
 * The broker is intentionally DI-friendly: `createRedisBroker` accepts
 * ready-made `pub` and `sub` clients so tests can exercise the refcount
 * and fan-out logic with fake clients. `createRedisBrokerFromUrl` is the
 * thin production wrapper that constructs real ioredis instances.
 */
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';

const CHANNEL_PREFIX = 'rushdesk:orders:';
const channelFor = (businessId) => `${CHANNEL_PREFIX}${businessId}`;

/**
 * @param {{
 *   pub: { publish: (channel: string, message: string) => unknown },
 *   sub: {
 *     subscribe: (channel: string) => unknown,
 *     unsubscribe: (channel: string) => unknown,
 *     on: (event: 'message', handler: (channel: string, message: string) => void) => unknown,
 *   },
 *   onError?: (err: unknown) => void,
 * }} deps
 */
export function createRedisBroker({ pub, sub, onError } = {}) {
  if (!pub || !sub) {
    throw new Error('createRedisBroker requires { pub, sub } Redis clients.');
  }

  const local = new EventEmitter();
  local.setMaxListeners(0);

  // businessId -> number of local handlers attached to that channel.
  const refcount = new Map();

  sub.on('message', (channel, message) => {
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const businessId = channel.slice(CHANNEL_PREFIX.length);
    try {
      const event = JSON.parse(message);
      local.emit(`b:${businessId}`, event);
    } catch (err) {
      onError?.(err);
    }
  });

  return {
    publish(businessId, event) {
      // Fire-and-forget; publish failures should not block the API
      // response. ioredis buffers commands while reconnecting.
      try {
        const result = pub.publish(channelFor(businessId), JSON.stringify(event));
        if (result && typeof result.catch === 'function') {
          result.catch((err) => onError?.(err));
        }
      } catch (err) {
        onError?.(err);
      }
    },

    subscribe(businessId, handler) {
      const localChannel = `b:${businessId}`;
      local.on(localChannel, handler);

      const prev = refcount.get(businessId) ?? 0;
      refcount.set(businessId, prev + 1);
      if (prev === 0) {
        try {
          const result = sub.subscribe(channelFor(businessId));
          if (result && typeof result.catch === 'function') {
            result.catch((err) => onError?.(err));
          }
        } catch (err) {
          onError?.(err);
        }
      }

      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        local.off(localChannel, handler);
        const remaining = (refcount.get(businessId) ?? 1) - 1;
        if (remaining <= 0) {
          refcount.delete(businessId);
          try {
            const result = sub.unsubscribe(channelFor(businessId));
            if (result && typeof result.catch === 'function') {
              result.catch((err) => onError?.(err));
            }
          } catch (err) {
            onError?.(err);
          }
        } else {
          refcount.set(businessId, remaining);
        }
      };
    },
  };
}

/**
 * Construct real ioredis connections for production use.
 *
 * The returned broker is safe to reuse across invocations within the
 * same warm container — see `orderEvents.js` for the module-level singleton.
 */
export function createRedisBrokerFromUrl(url, options = {}) {
  if (!url) throw new Error('REDIS_URL is required to create a Redis broker.');
  const clientOptions = {
    // Upstash and similar managed Redis sometimes take a beat to accept
    // a new TLS session from a cold lambda. Keep retries bounded but
    // resilient.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Allow publishing from a newly-warmed instance before the socket
    // is fully ready.
    enableOfflineQueue: true,
    ...options,
  };
  const pub = new Redis(url, clientOptions);
  const sub = new Redis(url, clientOptions);
  const onError = (err) => {
    // eslint-disable-next-line no-console
    console.error('[redisBroker]', err);
  };
  pub.on('error', onError);
  sub.on('error', onError);
  return createRedisBroker({ pub, sub, onError });
}
