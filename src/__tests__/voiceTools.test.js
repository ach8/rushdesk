import { describe, it, expect, vi } from 'vitest';
import { executeToolCall, normalizeSubmitOrderArgs } from '@/lib/voice/tools';
import { OrderError } from '@/lib/orders';

function baseCtx(overrides = {}) {
  return {
    businessId: 'biz_1',
    callerPhone: '+15551234567',
    conversationId: 'conv_abc123XYZ',
    ...overrides,
  };
}

describe('normalizeSubmitOrderArgs', () => {
  it('maps agent tool-call shape to createOrder shape and pins conversation_id as the idempotency key', () => {
    const args = {
      items: [{ menu_item_id: 'mi_1', quantity: 2, notes: 'no onions' }],
      order_type: 'TAKEAWAY',
      customer_name: '  Alice  ',
      order_notes: 'leave at door',
    };
    const out = normalizeSubmitOrderArgs(args, baseCtx());
    expect(out).toMatchObject({
      businessId: 'biz_1',
      customerName: 'Alice',
      customerPhone: '+15551234567',
      type: 'TAKEAWAY',
      source: 'VOICE',
      notes: 'leave at door',
      idempotencyKey: 'elevenlabs:conv_abc123XYZ',
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
      baseCtx(),
    );
    expect(out.items).toEqual([{ menuItemId: 'mi_ok', quantity: 1, notes: undefined }]);
  });

  it('defaults to TAKEAWAY when the model hallucinates an unknown order type', () => {
    const out = normalizeSubmitOrderArgs(
      { items: [{ menu_item_id: 'mi_1', quantity: 1 }], order_type: 'TELEPORT' },
      baseCtx(),
    );
    expect(out.type).toBe('TAKEAWAY');
  });

  it('coerces huge quantities to the schema cap', () => {
    const out = normalizeSubmitOrderArgs(
      { items: [{ menu_item_id: 'mi_1', quantity: 99999 }] },
      baseCtx(),
    );
    expect(out.items[0].quantity).toBe(99);
  });

  it('never reads customerPhone from the agent — only from the call context', () => {
    const out = normalizeSubmitOrderArgs(
      // Even if the agent fabricated a customer_phone field, it shouldn't land.
      { items: [{ menu_item_id: 'mi_1', quantity: 1 }], customer_phone: '+10000000000' },
      baseCtx({ callerPhone: '+15551234567' }),
    );
    expect(out.customerPhone).toBe('+15551234567');
  });

  it('omits idempotencyKey when no conversation_id is available', () => {
    const out = normalizeSubmitOrderArgs(
      { items: [{ menu_item_id: 'mi_1', quantity: 1 }] },
      baseCtx({ conversationId: null }),
    );
    expect(out.idempotencyKey).toBeUndefined();
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
      ctx: baseCtx(),
      deps: { createOrderImpl },
    });

    expect(result.ok).toBe(true);
    expect(result.order_id).toBe('order_abc123');
    expect(result.short_code).toBe('ABC123');
    expect(result.total).toBe(22.5);
    expect(result.items).toHaveLength(2);
    // We must have passed conversation_id through as the idempotency key so
    // ElevenLabs retries don't produce duplicate orders.
    expect(createOrderImpl.mock.calls[0][0].idempotencyKey).toBe('elevenlabs:conv_abc123XYZ');
  });

  it('submit_order: translates OrderError into a structured tool failure (no throw)', async () => {
    const createOrderImpl = vi.fn(async () => {
      throw new OrderError('menu_item_unavailable', 'Item unavailable.', { status: 409 });
    });
    const result = await executeToolCall({
      name: 'submit_order',
      args: { items: [{ menu_item_id: 'mi_1', quantity: 1 }], order_type: 'TAKEAWAY' },
      ctx: baseCtx(),
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
      ctx: baseCtx(),
      deps: { createOrderImpl },
    });
    expect(result.ok).toBe(false);
    expect(createOrderImpl).not.toHaveBeenCalled();
  });

  it('unknown tool: returns a structured error rather than throwing', async () => {
    const result = await executeToolCall({
      name: 'launch_missile',
      args: {},
      ctx: baseCtx(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });
});
