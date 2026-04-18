import { describe, it, expect } from 'vitest';
import { createOrderSchema, updateOrderStatusSchema } from '@/lib/orderValidation';

describe('createOrderSchema', () => {
  const base = {
    businessId: 'biz_123',
    items: [{ menuItemId: 'mi_1', quantity: 2 }],
  };

  it('accepts a minimal valid payload and applies defaults', () => {
    const res = createOrderSchema.safeParse(base);
    expect(res.success).toBe(true);
    expect(res.data.type).toBe('DINE_IN');
    expect(res.data.source).toBe('VOICE');
  });

  it('strips unknown monetary fields — clients cannot set totalAmount', () => {
    const res = createOrderSchema.safeParse({
      ...base,
      totalAmount: 0.01,
      items: [{ menuItemId: 'mi_1', quantity: 1, unitPrice: 0.01 }],
    });
    expect(res.success).toBe(true);
    expect(res.data).not.toHaveProperty('totalAmount');
    expect(res.data.items[0]).not.toHaveProperty('unitPrice');
  });

  it('rejects empty item lists', () => {
    const res = createOrderSchema.safeParse({ ...base, items: [] });
    expect(res.success).toBe(false);
  });

  it('rejects non-positive quantities', () => {
    const res = createOrderSchema.safeParse({
      ...base,
      items: [{ menuItemId: 'mi_1', quantity: 0 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects absurdly large quantities', () => {
    const res = createOrderSchema.safeParse({
      ...base,
      items: [{ menuItemId: 'mi_1', quantity: 10_000 }],
    });
    expect(res.success).toBe(false);
  });

  it('rejects malformed phone numbers', () => {
    const res = createOrderSchema.safeParse({
      ...base,
      customerPhone: 'not-a-phone',
    });
    expect(res.success).toBe(false);
  });
});

describe('updateOrderStatusSchema', () => {
  it('accepts known statuses', () => {
    expect(updateOrderStatusSchema.safeParse({ status: 'READY' }).success).toBe(true);
  });

  it('rejects unknown statuses', () => {
    expect(updateOrderStatusSchema.safeParse({ status: 'LAUNCHED' }).success).toBe(false);
  });
});
