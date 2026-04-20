import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createOrder, sweepExpiredPendingOrders } from '@/lib/orders';
import { setOrderEventBroker } from '@/lib/orderEvents';

/**
 * Advance-payment branch tests for `createOrder`.
 *
 * We inject a fake Prisma client + fake Stripe/Twilio adapters via the
 * `deps` parameter (per CLAUDE.md — no real external calls). The env
 * object is also injected so `isAdvancePaymentConfigured` returns true
 * without needing real credentials.
 */

const dec = (n) => ({ toString: () => String(n) });

// Env shape that satisfies `isAdvancePaymentConfigured`.
const CONFIGURED_ENV = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  TWILIO_ACCOUNT_SID: 'AC_test',
  TWILIO_AUTH_TOKEN: 'token_test',
  TWILIO_FROM_NUMBER: '+15550001111',
  APP_BASE_URL: 'https://rushdesk.test',
};

function makePrismaMock({ business, menuItems, existingByKey = null, onOrderUpdate = null }) {
  const miById = new Map(menuItems.map((m) => [m.id, m]));
  const createdOrders = [];
  const mockRef = { current: null };

  const prisma = {
    business: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === business.id
          ? {
              id: business.id,
              requireVoicePaymentUpfront: Boolean(business.requireVoicePaymentUpfront),
            }
          : null,
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
      create: vi.fn(async ({ data }) => {
        const created = {
          id: `order_${createdOrders.length + 1}`,
          createdAt: new Date('2026-04-20T12:00:00Z'),
          updatedAt: new Date('2026-04-20T12:00:00Z'),
          customerPhone: data.customerPhone ?? null,
          customerName: data.customerName ?? null,
          type: data.type,
          source: data.source,
          status: 'PENDING',
          businessId: data.businessId,
          notes: data.notes ?? null,
          totalAmount: data.totalAmount,
          paymentStatus: data.paymentStatus ?? 'NOT_REQUIRED',
          stripeSessionId: null,
          paymentUrl: null,
          items: data.items.create.map((row, i) => ({
            id: `oi_${i}`,
            menuItemId: row.menuItemId,
            quantity: row.quantity,
            unitPrice: row.unitPrice,
            notes: row.notes ?? null,
            menuItem: { name: miById.get(row.menuItemId)?.name },
          })),
        };
        createdOrders.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }) => {
        const order = createdOrders.find((o) => o.id === where.id);
        if (!order) throw new Error('order not found in mock');
        Object.assign(order, data);
        if (onOrderUpdate) onOrderUpdate(order, data);
        return order;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $transaction: vi.fn(async (fn) => fn(mockRef.current)),
  };
  mockRef.current = prisma;
  return { prisma, createdOrders };
}

beforeEach(() => {
  setOrderEventBroker({ publish: vi.fn(), subscribe: () => () => {} });
});

describe('createOrder — advance payment', () => {
  const INPUT = {
    businessId: 'biz_1',
    customerPhone: '+15551234567',
    source: 'VOICE',
    items: [{ menuItemId: 'mi_1', quantity: 2 }],
  };

  function menuFixture() {
    return [
      { id: 'mi_1', businessId: 'biz_1', name: 'Burger', price: dec('9.50'), available: true },
    ];
  }

  it('leaves legacy path untouched when the business toggle is OFF', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: false },
      menuItems: menuFixture(),
    });
    const publish = vi.fn();
    setOrderEventBroker({ publish, subscribe: () => () => {} });

    const createStripeSession = vi.fn();
    const sendPaymentSms = vi.fn();

    const { order } = await createOrder(INPUT, {
      prisma,
      createStripeSession,
      sendPaymentSms,
      env: CONFIGURED_ENV,
    });

    expect(order.paymentStatus).toBe('NOT_REQUIRED');
    expect(createStripeSession).not.toHaveBeenCalled();
    expect(sendPaymentSms).not.toHaveBeenCalled();
    // Legacy path publishes immediately.
    expect(publish).toHaveBeenCalledWith(
      'biz_1',
      expect.objectContaining({ type: 'order.created' }),
    );
  });

  it('creates a Stripe session, SMSes the caller, and does NOT publish when the toggle is ON', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: true },
      menuItems: menuFixture(),
    });
    const publish = vi.fn();
    setOrderEventBroker({ publish, subscribe: () => () => {} });

    const createStripeSession = vi.fn(async (order) => ({
      id: `cs_test_${order.id}`,
      url: `https://checkout.stripe.com/c/pay/${order.id}`,
    }));
    const sendPaymentSms = vi.fn(async () => ({ sid: 'SM_test' }));

    const { order } = await createOrder(INPUT, {
      prisma,
      createStripeSession,
      sendPaymentSms,
      env: CONFIGURED_ENV,
    });

    expect(order.paymentStatus).toBe('PENDING');
    expect(createStripeSession).toHaveBeenCalledTimes(1);
    expect(sendPaymentSms).toHaveBeenCalledWith(
      expect.objectContaining({
        toPhone: '+15551234567',
        paymentUrl: expect.stringContaining('https://checkout.stripe.com/'),
      }),
    );
    // CRITICAL: no publish — the kitchen must not see this order yet.
    expect(publish).not.toHaveBeenCalled();
    // The order row was updated with the session id + URL.
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeSessionId: expect.stringContaining('cs_test_'),
          paymentUrl: expect.stringContaining('https://checkout.stripe.com/'),
        }),
      }),
    );
  });

  it('refuses when advance payment is required but the caller has no phone', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: true },
      menuItems: menuFixture(),
    });
    const createStripeSession = vi.fn();
    const sendPaymentSms = vi.fn();

    await expect(
      createOrder(
        { ...INPUT, customerPhone: undefined },
        { prisma, createStripeSession, sendPaymentSms, env: CONFIGURED_ENV },
      ),
    ).rejects.toMatchObject({ code: 'phone_required_for_payment', status: 400 });

    expect(createStripeSession).not.toHaveBeenCalled();
    expect(sendPaymentSms).not.toHaveBeenCalled();
  });

  it('falls back to legacy path (publish + NOT_REQUIRED) when toggle is ON but env is incomplete', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: true },
      menuItems: menuFixture(),
    });
    const publish = vi.fn();
    setOrderEventBroker({ publish, subscribe: () => () => {} });

    const createStripeSession = vi.fn();
    const sendPaymentSms = vi.fn();

    // Missing STRIPE_SECRET_KEY — fail-open to legacy path.
    const incompleteEnv = { ...CONFIGURED_ENV, STRIPE_SECRET_KEY: undefined };

    const { order } = await createOrder(INPUT, {
      prisma,
      createStripeSession,
      sendPaymentSms,
      env: incompleteEnv,
    });

    expect(order.paymentStatus).toBe('NOT_REQUIRED');
    expect(createStripeSession).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('marks the order FAILED and does NOT publish if Stripe session creation throws', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: true },
      menuItems: menuFixture(),
    });
    const publish = vi.fn();
    setOrderEventBroker({ publish, subscribe: () => () => {} });

    const createStripeSession = vi.fn(async () => {
      throw new Error('Stripe is down');
    });
    const sendPaymentSms = vi.fn();

    const { order } = await createOrder(INPUT, {
      prisma,
      createStripeSession,
      sendPaymentSms,
      env: CONFIGURED_ENV,
    });

    expect(order.paymentStatus).toBe('FAILED');
    expect(sendPaymentSms).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('is non-voice-safe: a WEB order is never gated regardless of the toggle', async () => {
    const { prisma } = makePrismaMock({
      business: { id: 'biz_1', requireVoicePaymentUpfront: true },
      menuItems: menuFixture(),
    });
    const publish = vi.fn();
    setOrderEventBroker({ publish, subscribe: () => () => {} });
    const createStripeSession = vi.fn();

    const { order } = await createOrder(
      { ...INPUT, source: 'WEB' },
      { prisma, createStripeSession, env: CONFIGURED_ENV },
    );

    expect(order.paymentStatus).toBe('NOT_REQUIRED');
    expect(createStripeSession).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });
});

describe('sweepExpiredPendingOrders', () => {
  it('cancels orders whose PENDING payment is older than the TTL', async () => {
    const prisma = {
      order: {
        updateMany: vi.fn(async () => ({ count: 3 })),
      },
    };
    const fixedNow = new Date('2026-04-20T12:00:00Z');
    const { cancelled } = await sweepExpiredPendingOrders(
      { olderThanMinutes: 30 },
      { prisma, now: () => fixedNow },
    );

    expect(cancelled).toBe(3);
    // Conditional update scoped exclusively to PENDING orders older than
    // the cutoff — won't ever touch NOT_REQUIRED / PAID / already
    // EXPIRED rows, and won't prematurely cancel a just-placed order.
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        paymentStatus: 'PENDING',
        createdAt: { lt: new Date('2026-04-20T11:30:00Z') },
      },
      data: {
        paymentStatus: 'EXPIRED',
        status: 'CANCELLED',
      },
    });
  });

  it('is a safe no-op when there is nothing to sweep', async () => {
    const prisma = {
      order: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    const { cancelled } = await sweepExpiredPendingOrders({}, { prisma });
    expect(cancelled).toBe(0);
  });
});
