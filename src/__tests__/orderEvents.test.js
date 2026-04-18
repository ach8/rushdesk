import { describe, it, expect, vi } from 'vitest';
import { publishOrderEvent, subscribeToOrderEvents } from '@/lib/orderEvents';

describe('order events broker', () => {
  it('delivers events to subscribers of the matching businessId', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToOrderEvents('biz_1', handler);

    publishOrderEvent({
      type: 'order.created',
      businessId: 'biz_1',
      order: { id: 'o1' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].order.id).toBe('o1');

    unsubscribe();
    publishOrderEvent({
      type: 'order.updated',
      businessId: 'biz_1',
      order: { id: 'o1' },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not leak events across businesses', () => {
    const a = vi.fn();
    const b = vi.fn();
    const unA = subscribeToOrderEvents('biz_A', a);
    const unB = subscribeToOrderEvents('biz_B', b);

    publishOrderEvent({
      type: 'order.created',
      businessId: 'biz_A',
      order: { id: 'o1' },
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    unA();
    unB();
  });
});
