import { describe, it, expect, vi } from 'vitest';
import { executeToolCall, normalizeSubmitOrderArgs } from '@/lib/voice/tools';
import { OrderError } from '@/lib/orders';

function baseSession(overrides = {}) {
  return {
    callSid: 'CAxxxxxxxxxxxxxxxxxx1234',
    businessId: 'biz_1',
    from: '+15551234567',
    to: '+15550001111',
    messages: [],
    turnCount: 1,
    placedOrderId: null,
    done: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('normalizeSubmitOrderArgs', () => {
  it('maps AI tool-call shape to createOrder shape and pins CallSid as the idempotency key', () => {
    const args = {
      items: [{ menu_item_id: 'mi_1', quantity: 2, notes: 'no onions' }],
      order_type: 'TAKEAWAY',
      customer_name: '  Alice  ',
      order_notes: 'leave at door',
    };
    const out = normalizeSubmitOrderArgs(args, { session: baseSession() });
    expect(out).toMatchObject({
      businessId: 'biz_1',
      customerName: 'Alice',
      customerPhone: '+15551234567',
      type: 'TAKEAWAY',
      source: 'VOICE',
      notes: 'leave at door',
      idempotencyKey: 'CAxxxxxxxxxxxxxxxxxx1234',
      items: [{ menuItemId: 'mi_1', quantity: 2, notes: 'no onions' }],
    });
  });

  it('drops malformed items (no id or bad quantity) rather than crashing the call', () => {
    const out = normalizeSubmitOrderArgs(
      {
        items: [
          { menu_item_id: 'mi_ok', quantity: 1 },
          { quantity: 2 }, // missing id
          { menu_item_id: 'mi_bad', quantity: 'hello' }, // non-numeric
          { menu_item_id: 'mi_zero', quantity: 0 },
        ],
      },
      { session: baseSession() },
    );
    expect(out.items).toEqual([{ menuItemId: 'mi_ok', quantity: 1, notes: undefined }]);
  });

  it('defaults to TAKEAWAY when the model hallucinates an unknown order type', () => {
    const out = normalizeSubmitOrderArgs(
      { items: [{ menu_item_id: 'mi_1', quantity: 1 }], order_type: 'TELEPORT' },
      { session: baseSession() },
    );
    expect(out.type).toBe('TAKEAWAY');
  });

  it('coerces huge quantities to the schema cap', () => {
    const out = normalizeSubmitOrderArgs(
      { items: [{ menu_item_id: 'mi_1', quantity: 99999 }] },
      { session: baseSession() },
    );
    expect(out.items[0].quantity).toBe(99);
  });

  it('never reads customerPhone from the AI — only from the session (caller ID)', () => {
    const out = normalizeSubmitOrderArgs(
      // Even if the AI fabricated a customer_phone field, it shouldn't land.
      { items: [{ menu_item_id: 'mi_1', quantity: 1 }], customer_phone: '+10000000000' },
      { session: baseSession({ from: '+15551234567' }) },
    );
    expect(out.customerPhone).toBe('+15551234567');
  });
});

describe('executeToolCall', () => {
  it('submit_order: happy path returns a spoken-friendly summary', async () => {
    const createOrderImpl = vi.fn(async () => ({
      order: {
        id: 'order_abc123',
        totalAmount: 22.5,
        items: [
          { menuItemName: 'Burger', quantity: 2, notes: 'no onions' },
          { menuItemName: 'Fries', quantity: 1, notes: null },
        ],
      },
      created: true,
    }));

    const result = await executeToolCall({
      name: 'submit_order',
      args: {
        items: [{ menu_item_id: 'mi_1', quantity: 2, notes: 'no onions' }],
        order_type: 'TAKEAWAY',
      },
      session: baseSession(),
      deps: { createOrderImpl },
    });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe('order_abc123');
    expect(result.short_code).toBe('ABC123');
    expect(result.total).toBe(22.5);
    expect(result.items).toHaveLength(2);
    // We must have passed CallSid through as the idempotency key so
    // Twilio retries don't produce duplicate orders.
    expect(createOrderImpl.mock.calls[0][0].idempotencyKey).toBe('CAxxxxxxxxxxxxxxxxxx1234');
  });

  it('submit_order: translates OrderError into a structured tool failure (no throw)', async () => {
    const createOrderImpl = vi.fn(async () => {
      throw new OrderError('menu_item_unavailable', 'Item unavailable.', { status: 409 });
    });
    const result = await executeToolCall({
      name: 'submit_order',
      args: { items: [{ menu_item_id: 'mi_1', quantity: 1 }], order_type: 'TAKEAWAY' },
      session: baseSession(),
      deps: { createOrderImpl },
    });
    expect(result).toEqual({
      ok: false,
      code: 'menu_item_unavailable',
      error: 'Item unavailable.',
    });
  });

  it('submit_order: rejects a call with zero valid items without hitting createOrder', async () => {
    const createOrderImpl = vi.fn();
    const result = await executeToolCall({
      name: 'submit_order',
      args: { items: [{ quantity: 1 }], order_type: 'TAKEAWAY' },
      session: baseSession(),
      deps: { createOrderImpl },
    });
    expect(result.ok).toBe(false);
    expect(createOrderImpl).not.toHaveBeenCalled();
  });

  it('unknown tool: returns a structured error rather than throwing', async () => {
    const result = await executeToolCall({
      name: 'launch_missile',
      args: {},
      session: baseSession(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});
