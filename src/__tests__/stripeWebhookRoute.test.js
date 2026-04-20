import { describe, it, expect, vi } from 'vitest';
import { handleStripeWebhook } from '@/app/api/stripe/webhook/route';

/**
 * Integration-style tests for the Stripe webhook route. We inject:
 *   - `verifyEvent`: stubs Stripe's signature verification so tests
 *     don't depend on real HMACs.
 *   - `prisma`: tracks the conditional update + subsequent hydrate.
 *   - `publishOrderEvent`: asserted to fire exactly once on
 *     `checkout.session.completed`.
 */

function makeRequest(rawBody = '{}', headers = { 'stripe-signature': 't=1,v1=sig' }) {
  return new Request('https://rushdesk.test/api/stripe/webhook', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

function makePrismaMock({ orderFixture, pendingCount = 1 }) {
  return {
    order: {
      updateMany: vi.fn(async () => ({ count: pendingCount })),
      findUnique: vi.fn(async () => orderFixture),
    },
  };
}

const ORDER = {
  id: 'order_1',
  businessId: 'biz_1',
  customerName: 'Alex',
  customerPhone: '+15551234567',
  type: 'TAKEAWAY',
  status: 'PENDING',
  source: 'VOICE',
  totalAmount: { toString: () => '19.00' },
  notes: null,
  paymentStatus: 'PAID',
  paymentUrl: 'https://checkout.stripe.com/c/pay/x',
  stripeSessionId: 'cs_test_abc',
  createdAt: new Date('2026-04-20T12:00:00Z'),
  updatedAt: new Date('2026-04-20T12:00:00Z'),
  items: [
    {
      id: 'oi_1',
      menuItemId: 'mi_1',
      quantity: 2,
      unitPrice: { toString: () => '9.50' },
      notes: null,
      menuItem: { name: 'Burger' },
    },
  ],
};

describe('POST /api/stripe/webhook', () => {
  it('rejects with 400 when signature verification throws, without touching the DB', async () => {
    const prisma = makePrismaMock({ orderFixture: ORDER });
    const publishOrderEvent = vi.fn();
    const verifyEvent = vi.fn(() => {
      throw new Error('bad signature');
    });

    const res = await handleStripeWebhook(makeRequest('{}'), {
      prisma,
      verifyEvent,
      publishOrderEvent,
    });

    expect(res.status).toBe(400);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(publishOrderEvent).not.toHaveBeenCalled();
  });

  it('marks the order PAID and publishes exactly once on checkout.session.completed', async () => {
    const prisma = makePrismaMock({ orderFixture: ORDER, pendingCount: 1 });
    const publishOrderEvent = vi.fn();
    const verifyEvent = vi.fn(() => ({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_abc' } },
    }));

    const res = await handleStripeWebhook(makeRequest(), {
      prisma,
      verifyEvent,
      publishOrderEvent,
    });

    expect(res.status).toBe(200);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: 'cs_test_abc', paymentStatus: 'PENDING' },
      data: { paymentStatus: 'PAID' },
    });
    expect(publishOrderEvent).toHaveBeenCalledTimes(1);
    expect(publishOrderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'order.created',
        businessId: 'biz_1',
        order: expect.objectContaining({ id: 'order_1', paymentStatus: 'PAID' }),
      }),
    );
  });

  it('is idempotent: a replayed checkout.session.completed does not re-publish', async () => {
    // pendingCount=0 means the conditional updateMany matched nothing —
    // order was already PAID from a prior delivery.
    const prisma = makePrismaMock({ orderFixture: ORDER, pendingCount: 0 });
    const publishOrderEvent = vi.fn();
    const verifyEvent = vi.fn(() => ({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_abc' } },
    }));

    const res = await handleStripeWebhook(makeRequest(), {
      prisma,
      verifyEvent,
      publishOrderEvent,
    });

    expect(res.status).toBe(200);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(publishOrderEvent).not.toHaveBeenCalled();
  });

  it('cancels the order on checkout.session.expired and does NOT publish', async () => {
    const prisma = makePrismaMock({ orderFixture: ORDER });
    const publishOrderEvent = vi.fn();
    const verifyEvent = vi.fn(() => ({
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_test_abc' } },
    }));

    const res = await handleStripeWebhook(makeRequest(), {
      prisma,
      verifyEvent,
      publishOrderEvent,
    });

    expect(res.status).toBe(200);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { stripeSessionId: 'cs_test_abc', paymentStatus: 'PENDING' },
      data: { paymentStatus: 'EXPIRED', status: 'CANCELLED' },
    });
    expect(publishOrderEvent).not.toHaveBeenCalled();
  });

  it('acks unrelated event types with 200 and no side effects', async () => {
    const prisma = makePrismaMock({ orderFixture: ORDER });
    const publishOrderEvent = vi.fn();
    const verifyEvent = vi.fn(() => ({
      type: 'customer.created',
      data: { object: { id: 'cus_test' } },
    }));

    const res = await handleStripeWebhook(makeRequest(), {
      prisma,
      verifyEvent,
      publishOrderEvent,
    });

    expect(res.status).toBe(200);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(publishOrderEvent).not.toHaveBeenCalled();
  });
});
