import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrder, updateOrderStatus, resolveActiveBusinessId, OrderError } from '@/lib/orders';
import { setOrderEventBroker } from '@/lib/orderEvents';

/**
 * These tests exercise the server-side integrity guarantees of order
 * creation and status updates without touching a real database. We inject
 * a fake Prisma client via the `deps` parameter (per CLAUDE.md).
 */

// Minimal Decimal stand-in — Prisma's Decimal also exposes toString().
const dec = (n) => ({ toString: () => String(n) });

function makePrismaMock({ business, menuItems, existingByKey = null }) {
  const miById = new Map(menuItems.map((m) => [m.id, m]));
  return {
    business: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === business.id ? { id: business.id } : null,
      ),
      findFirst: vi.fn(async () => ({ id: business.id })),
    },
    menuItem: {
      findMany: vi.fn(async ({ where }) => {
        const ids = where.id.in;
        return ids
          .map((id) => miById.get(id))
          .filter((mi) => mi && mi.businessId === where.businessId);
      }),
    },
    order: {
      findUnique: vi.fn(async () => existingByKey),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({
        id: 'order_created_1',
        createdAt: new Date('2026-04-17T12:00:00Z'),
        updatedAt: new Date('2026-04-17T12:00:00Z'),
        ...data,
        items: data.items.create.map((row, i) => ({
          id: `oi_${i}`,
          menuItemId: row.menuItemId,
          quantity: row.quantity,
          unitPrice: row.unitPrice,
          notes: row.notes ?? null,
          menuItem: { name: miById.get(row.menuItemId)?.name },
        })),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn) => fn(mockRef.current)),
  };
}
const mockRef = { current: null };

beforeEach(() => {
  // Silence event publication in unit tests.
  setOrderEventBroker({ publish: () => {}, subscribe: () => () => {} });
});

describe('createOrder', () => {
  it('computes totalAmount server-side from DB-resolved prices', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
        { id: 'mi_2', businessId: 'biz_1', name: 'Fries', price: dec('3.25'), available: true },
      ],
    });
    mockRef.current = prisma;

    const { order, created } = await createOrder(
      {
        businessId: 'biz_1',
        items: [
          { menuItemId: 'mi_1', quantity: 2 }, // 19.00
          { menuItemId: 'mi_2', quantity: 1 }, //  3.25
        ],
      },
      { prisma },
    );

    expect(created).toBe(true);
    expect(order.totalAmount).toBe(22.25);
    expect(order.items.map((i) => i.unitPrice).sort()).toEqual([3.25, 9.5]);
  });

  it('ignores a client-submitted totalAmount', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
      ],
    });
    mockRef.current = prisma;

    const { order } = await createOrder(
      {
        businessId: 'biz_1',
        totalAmount: 0.01,
        items: [{ menuItemId: 'mi_1', quantity: 1, unitPrice: 0.01 }],
      },
      { prisma },
    );
    expect(order.totalAmount).toBe(9.5);
  });

  it('preserves per-item notes and keeps lines with distinct notes separate', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
      ],
    });
    mockRef.current = prisma;

    const { order } = await createOrder(
      {
        businessId: 'biz_1',
        items: [
          { menuItemId: 'mi_1', quantity: 2, notes: 'no onions' },
          { menuItemId: 'mi_1', quantity: 1, notes: 'extra cheese' },
        ],
      },
      { prisma },
    );

    // Two distinct kitchen lines preserved.
    expect(order.items).toHaveLength(2);
    const byNote = Object.fromEntries(order.items.map((i) => [i.notes, i.quantity]));
    expect(byNote).toEqual({ 'no onions': 2, 'extra cheese': 1 });
    // Total still accounts for all 3 burgers.
    expect(order.totalAmount).toBe(28.5);
  });

  it('coalesces identical lines with identical notes', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
      ],
    });
    mockRef.current = prisma;

    const { order } = await createOrder(
      {
        businessId: 'biz_1',
        items: [
          { menuItemId: 'mi_1', quantity: 1 },
          { menuItemId: 'mi_1', quantity: 2 },
        ],
      },
      { prisma },
    );
    expect(order.items).toHaveLength(1);
    expect(order.items[0].quantity).toBe(3);
  });

  it('rejects menu items that belong to a different business', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_other', name: 'x', price: dec('5'), available: true },
      ],
    });
    mockRef.current = prisma;

    await expect(
      createOrder(
        { businessId: 'biz_1', items: [{ menuItemId: 'mi_1', quantity: 1 }] },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: 'menu_item_not_found', status: 400 });
  });

  it('rejects unavailable menu items', async () => {
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'x', price: dec('5'), available: false },
      ],
    });
    mockRef.current = prisma;

    await expect(
      createOrder(
        { businessId: 'biz_1', items: [{ menuItemId: 'mi_1', quantity: 1 }] },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: 'menu_item_unavailable' });
  });

  it('returns the existing order for a repeated idempotency key', async () => {
    const existing = {
      id: 'order_existing',
      businessId: 'biz_1',
      type: 'DINE_IN',
      status: 'PENDING',
      source: 'VOICE',
      totalAmount: dec('9.50'),
      createdAt: new Date('2026-04-17T11:00:00Z'),
      updatedAt: new Date('2026-04-17T11:00:00Z'),
      items: [],
    };
    const prisma = makePrismaMock({
      business: { id: 'biz_1' },
      menuItems: [
        { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
      ],
      existingByKey: existing,
    });
    mockRef.current = prisma;

    const { order, created } = await createOrder(
      {
        businessId: 'biz_1',
        idempotencyKey: 'call_sid_abc123',
        items: [{ menuItemId: 'mi_1', quantity: 1 }],
      },
      { prisma },
    );
    expect(created).toBe(false);
    expect(order.id).toBe('order_existing');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('rejects invalid payloads with an OrderError', async () => {
    const prisma = makePrismaMock({ business: { id: 'biz_1' }, menuItems: [] });
    await expect(
      createOrder({ businessId: 'biz_1', items: [] }, { prisma }),
    ).rejects.toBeInstanceOf(OrderError);
  });
});

describe('updateOrderStatus', () => {
  function orderFixture({ status = 'PENDING' } = {}) {
    return {
      id: 'o1',
      businessId: 'biz_1',
      status,
      totalAmount: dec('5'),
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [],
      type: 'DINE_IN',
      source: 'VOICE',
    };
  }

  it('allows the PENDING → PREPARING transition', async () => {
    const prisma = makePrismaMock({ business: { id: 'biz_1' }, menuItems: [] });
    prisma.order.findFirst = vi.fn(async () => ({ status: 'PENDING' }));
    prisma.order.findUnique = vi.fn(async () => orderFixture({ status: 'PREPARING' }));

    const order = await updateOrderStatus(
      { orderId: 'o1', businessId: 'biz_1', status: 'PREPARING' },
      { prisma },
    );
    expect(order.status).toBe('PREPARING');
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', businessId: 'biz_1', status: 'PENDING' },
      data: { status: 'PREPARING' },
    });
  });

  it('rejects invalid transitions (e.g. PREPARING → PENDING)', async () => {
    const prisma = makePrismaMock({ business: { id: 'biz_1' }, menuItems: [] });
    prisma.order.findFirst = vi.fn(async () => ({ status: 'PREPARING' }));

    await expect(
      updateOrderStatus({ orderId: 'o1', businessId: 'biz_1', status: 'PENDING' }, { prisma }),
    ).rejects.toMatchObject({ code: 'invalid_transition', status: 409 });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('treats cross-tenant access as not_found (does not leak existence)', async () => {
    const prisma = makePrismaMock({ business: { id: 'biz_1' }, menuItems: [] });
    prisma.order.findFirst = vi.fn(async () => null);

    await expect(
      updateOrderStatus(
        { orderId: 'o1', businessId: 'biz_attacker', status: 'PREPARING' },
        { prisma },
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('returns a conflict when a concurrent update won the race', async () => {
    const prisma = makePrismaMock({ business: { id: 'biz_1' }, menuItems: [] });
    prisma.order.findFirst = vi.fn(async () => ({ status: 'PENDING' }));
    prisma.order.updateMany = vi.fn(async () => ({ count: 0 }));

    await expect(
      updateOrderStatus({ orderId: 'o1', businessId: 'biz_1', status: 'PREPARING' }, { prisma }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});

describe('resolveActiveBusinessId', () => {
  it('sources the businessId from the DB, never the caller', async () => {
    const prisma = {
      business: { findFirst: vi.fn(async () => ({ id: 'biz_server_trusted' })) },
    };
    const id = await resolveActiveBusinessId({ prisma });
    expect(id).toBe('biz_server_trusted');
    expect(prisma.business.findFirst).toHaveBeenCalled();
  });
});
