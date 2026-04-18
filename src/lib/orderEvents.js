/**
 * Order event broker — per-business pub/sub used by the SSE stream.
 *
 * Transport selection
 * -------------------
 * The transport is chosen at module load based on `REDIS_URL`:
 *
 *   - `REDIS_URL` present  → distributed Redis Pub/Sub broker. This is
 *     the production path on Vercel (Upstash Redis). Every warm lambda
 *     container holds exactly two Redis connections (one `pub`, one
 *     `sub`) and fans messages out to local SSE subscribers in memory.
 *     Events published on container A therefore reach subscribers on
 *     container B without any additional wiring.
 *
 *   - `REDIS_URL` absent   → in-process EventEmitter. Correct for local
 *     development, unit tests, and single-node deployments. Keeps the
 *     test suite hermetic — no Redis required.
 *
 * The `{ publish, subscribe }` contract is identical in both cases, so
 * nothing in the rest of the codebase needs to know which transport is
 * active. `setOrderEventBroker` remains available for tests to inject a
 * stub broker.
 *
 * Connection / pool notes (Vercel serverless)
 * -------------------------------------------
 *   - Pub/sub is deliberately kept OFF the Postgres connection pool. We
 *     do not use Postgres LISTEN/NOTIFY because it would hold one DB
 *     connection per SSE subscriber across the fleet, and Supabase's
 *     pool is sized for query traffic, not for one-per-browser.
 *   - The Redis broker creates exactly TWO connections per container
 *     (not per request): `pub` for publishes, `sub` for SUBSCRIBE. Local
 *     SSE subscribers are multiplexed over the single `sub` socket via
 *     a refcounted in-memory EventEmitter inside `redisBroker.js`.
 *
 * Channel key: `businessId` — kitchens only see their own orders.
 */
import { EventEmitter } from 'node:events';
import { createRedisBrokerFromUrl } from './redisBroker.js';

/**
 * @typedef {Object} OrderEvent
 * @property {'order.created' | 'order.updated'} type
 * @property {string} businessId
 * @property {object} order     Serializable order payload.
 */

/**
 * @typedef {Object} Broker
 * @property {(businessId: string, event: OrderEvent) => void} publish
 * @property {(businessId: string, handler: (event: OrderEvent) => void) => () => void} subscribe
 *           Returns an unsubscribe function.
 */

function createInMemoryBroker() {
  const emitter = new EventEmitter();
  // SSE connections can pile up; lift the default of 10 so Node does not
  // log spurious "possible memory leak" warnings on a busy kitchen.
  emitter.setMaxListeners(0);

  return {
    publish(businessId, event) {
      emitter.emit(`b:${businessId}`, event);
    },
    subscribe(businessId, handler) {
      const channel = `b:${businessId}`;
      emitter.on(channel, handler);
      return () => emitter.off(channel, handler);
    },
  };
}

function selectDefaultBroker() {
  const url = process.env.REDIS_URL;
  if (url && url.trim().length > 0) {
    try {
      return createRedisBrokerFromUrl(url);
    } catch (err) {
      // Don't fail app boot if Redis is misconfigured — log and fall
      // back to the in-memory transport so local traffic still works.
      // eslint-disable-next-line no-console
      console.error('[orderEvents] falling back to in-memory broker:', err);
    }
  }
  return createInMemoryBroker();
}

// Reuse across hot reloads in dev to avoid losing subscribers and to
// avoid opening redundant Redis connections.
const globalForBroker = globalThis;
let broker = globalForBroker.__rushdeskOrderBroker ?? selectDefaultBroker();
if (process.env.NODE_ENV !== 'production') {
  globalForBroker.__rushdeskOrderBroker = broker;
}

export function getOrderEventBroker() {
  return broker;
}

/** Override the broker — e.g. with a stub in tests. */
export function setOrderEventBroker(customBroker) {
  broker = customBroker;
  if (process.env.NODE_ENV !== 'production') {
    globalForBroker.__rushdeskOrderBroker = customBroker;
  }
}

export function publishOrderEvent(event) {
  broker.publish(event.businessId, event);
}

export function subscribeToOrderEvents(businessId, handler) {
  return broker.subscribe(businessId, handler);
}
