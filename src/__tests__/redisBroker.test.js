import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { createRedisBroker } from '@/lib/redisBroker';

/**
 * Fake ioredis client pair. `pub.publish(channel, msg)` is relayed to the
 * `sub` emitter so we can simulate the round-trip through a real Redis
 * broker without needing one. Refcounting and local fan-out are the
 * behaviors under test.
 */
function makeFakeRedisPair() {
  const wire = new EventEmitter();
  const sub = new EventEmitter();
  sub.subscribe = vi.fn((channel) => {
    const relay = (c, m) => {
      if (c === channel) sub.emit('message', c, m);
    };
    sub._relays = sub._relays ?? new Map();
    sub._relays.set(channel, relay);
    wire.on('publish', relay);
    return Promise.resolve();
  });
  sub.unsubscribe = vi.fn((channel) => {
    const relay = sub._relays?.get(channel);
    if (relay) {
      wire.off('publish', relay);
      sub._relays.delete(channel);
    }
    return Promise.resolve();
  });

  const pub = {
    publish: vi.fn((channel, message) => {
      wire.emit('publish', channel, message);
      return Promise.resolve(1);
    }),
  };

  return { pub, sub };
}

describe('redisBroker', () => {
  it('fans a publish out to every local subscriber for the business', () => {
    const { pub, sub } = makeFakeRedisPair();
    const broker = createRedisBroker({ pub, sub });

    const a = vi.fn();
    const b = vi.fn();
    broker.subscribe('biz_1', a);
    broker.subscribe('biz_1', b);

    broker.publish('biz_1', { type: 'order.created', businessId: 'biz_1', order: { id: 'o1' } });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0][0].order.id).toBe('o1');
  });

  it('only holds ONE Redis SUBSCRIBE per channel regardless of local subscribers', () => {
    const { pub, sub } = makeFakeRedisPair();
    const broker = createRedisBroker({ pub, sub });

    broker.subscribe('biz_1', () => {});
    broker.subscribe('biz_1', () => {});
    broker.subscribe('biz_1', () => {});

    expect(sub.subscribe).toHaveBeenCalledTimes(1);
    expect(sub.subscribe).toHaveBeenCalledWith('rushdesk:orders:biz_1');
    // We didn't publish anything, but we also shouldn't have touched pub.
    expect(pub.publish).not.toHaveBeenCalled();
  });

  it('unsubscribes from Redis only when the last local subscriber leaves', () => {
    const { pub: _pub, sub } = makeFakeRedisPair();
    const broker = createRedisBroker({ pub: _pub, sub });

    const off1 = broker.subscribe('biz_1', () => {});
    const off2 = broker.subscribe('biz_1', () => {});

    off1();
    expect(sub.unsubscribe).not.toHaveBeenCalled();

    off2();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.unsubscribe).toHaveBeenCalledWith('rushdesk:orders:biz_1');
  });

  it('does not cross-deliver events between businesses', () => {
    const { pub, sub } = makeFakeRedisPair();
    const broker = createRedisBroker({ pub, sub });

    const aHandler = vi.fn();
    const bHandler = vi.fn();
    broker.subscribe('biz_A', aHandler);
    broker.subscribe('biz_B', bHandler);

    broker.publish('biz_A', { type: 'order.updated', businessId: 'biz_A', order: { id: 'o1' } });

    expect(aHandler).toHaveBeenCalledTimes(1);
    expect(bHandler).not.toHaveBeenCalled();
  });

  it('serializes the payload through Redis (publishes strings, parses on the way back)', () => {
    const { pub, sub } = makeFakeRedisPair();
    const broker = createRedisBroker({ pub, sub });

    broker.subscribe('biz_1', () => {});
    broker.publish('biz_1', { type: 'order.created', businessId: 'biz_1', order: { id: 'o1' } });

    const [, message] = pub.publish.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(JSON.parse(message).order.id).toBe('o1');
  });

  it('swallows malformed messages from Redis without throwing', () => {
    const { pub: _pub, sub } = makeFakeRedisPair();
    const onError = vi.fn();
    const broker = createRedisBroker({ pub: _pub, sub, onError });

    const handler = vi.fn();
    broker.subscribe('biz_1', handler);

    // Simulate a malformed payload arriving on the sub socket.
    sub.emit('message', 'rushdesk:orders:biz_1', '{not valid json');

    expect(handler).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('requires both pub and sub clients', () => {
    expect(() => createRedisBroker({})).toThrow(/pub.*sub/i);
  });
});
