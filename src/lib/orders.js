/**
 * Order creation + status updates.
 *
 * Trust & integrity invariants (see CLAUDE.md):
 *   - `Order.totalAmount` is computed server-side from DB-resolved prices.
 *     A client-submitted total is NEVER honored.
 *   - `OrderItem.unitPrice` is a snapshot of the MenuItem price at order
 *     creation time, read inside the same transaction that creates the row.
 *   - MenuItems are validated to belong to the target business and to be
 *     currently available — callers cannot smuggle items from another
 *     business or re-enable a disabled item.
 *   - Idempotency: a repeated call with the same (businessId, idempotencyKey)
 *     returns the existing order instead of creating a duplicate.
 *
 * All data-access functions accept a `deps = { prisma }` parameter so they
 * remain unit-testable without a live database.
 */
import { prisma as defaultPrisma } from './prisma.js';
import { publishOrderEvent } from './orderEvents.js';
import {
  createOrderSchema,
  updateOrderStatusSchema,
  ALLOWED_STATUS_TRANSITIONS,
} from './orderValidation.js';
import { createSessionForOrder as defaultCreateSession } from './stripe.js';
import {
  sendPaymentSms as defaultSendPaymentSms,
  sendOrderReadySms as defaultSendOrderReadySms,
} from './twilio.js';
import { isAdvancePaymentConfigured } from './businessSettings.js';

export class OrderError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Shape returned to clients — strips internal fields and coerces Decimal
 * to a number with two-decimal precision for JSON transport.
 */
export function serializeOrder(order) {
  return {
    id: order.id,
    businessId: order.businessId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    type: order.type,
    status: order.status,
    source: order.source,
    totalAmount: Number(order.totalAmount),
    notes: order.notes,
    paymentStatus: order.paymentStatus ?? 'NOT_REQUIRED',
    paymentUrl: order.paymentUrl ?? null,
    createdAt: order.createdAt instanceof Date ? order.createdAt.toISOString() : order.createdAt,
    updatedAt: order.updatedAt instanceof Date ? order.updatedAt.toISOString() : order.updatedAt,
    items: (order.items ?? []).map((item) => ({
      id: item.id,
      menuItemId: item.menuItemId,
      menuItemName: item.menuItem?.name,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      notes: item.notes ?? null,
    })),
  };
}

/**
 * Create an order atomically. Throws `OrderError` on validation/integrity
 * failure; callers should map the `.status` to an HTTP response.
 */
/**
 * Decide — server-side — whether this order must transit the advance-
 * payment flow before reaching the kitchen.
 *
 * Rule: voice orders for a business whose `requireVoicePaymentUpfront`
 * toggle is on AND whose environment has Stripe/Twilio/APP_BASE_URL
 * fully configured. If the toggle is on but any env var is missing we
 * FAIL OPEN (legacy no-payment flow) and log loudly — dropping orders
 * silently because of a deployment misconfiguration would be worse than
 * briefly letting one through without payment.
 *
 * Non-voice orders are never gated regardless of the toggle.
 */
function shouldRequireAdvancePayment({ source, businessRequires, env }) {
  if (source !== 'VOICE') return false;
  if (!businessRequires) return false;
  if (!isAdvancePaymentConfigured(env)) {
    // eslint-disable-next-line no-console
    console.error(
      '[orders.createOrder] requireVoicePaymentUpfront is ON but Stripe/Twilio env is incomplete. ' +
        'Falling back to immediate kitchen publish for this order.',
    );
    return false;
  }
  return true;
}

export async function createOrder(input, deps = {}) {
  const {
    prisma = defaultPrisma,
    createStripeSession = defaultCreateSession,
    sendPaymentSms = defaultSendPaymentSms,
    env,
  } = deps;
  const parsed = createOrderSchema.safeParse(input);
  if (!parsed.success) {
    throw new OrderError('invalid_input', 'Invalid order payload.', {
      status: 400,
      details: parsed.error.flatten(),
    });
  }
  const data = parsed.data;

  // Fast-path idempotency check outside the transaction — saves a round
  // trip on retries. The DB unique constraint is the final authority.
  if (data.idempotencyKey) {
    const existing = await prisma.order.findUnique({
      where: {
        businessId_idempotencyKey: {
          businessId: data.businessId,
          idempotencyKey: data.idempotencyKey,
        },
      },
      include: { items: { include: { menuItem: true } } },
    });
    if (existing) return { order: serializeOrder(existing), created: false };
  }

  // Coalesce identical lines (same menuItemId AND same notes) but keep
  // lines with distinct notes separate — "2 burgers, no onions" and
  // "1 burger, extra cheese" are three burgers but two kitchen lines.
  const lineByKey = new Map();
  for (const { menuItemId, quantity, notes } of data.items) {
    const key = `${menuItemId}\u0000${notes ?? ''}`;
    const existing = lineByKey.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      lineByKey.set(key, { menuItemId, quantity, notes: notes ?? null });
    }
  }
  const lines = [...lineByKey.values()];
  const menuItemIds = [...new Set(lines.map((l) => l.menuItemId))];

  try {
    const { created, paymentRequired } = await prisma.$transaction(async (tx) => {
      const business = await tx.business.findUnique({
        where: { id: data.businessId },
        select: { id: true, requireVoicePaymentUpfront: true },
      });
      if (!business) {
        throw new OrderError('business_not_found', 'Business not found.', {
          status: 404,
        });
      }

      const paymentRequired = shouldRequireAdvancePayment({
        source: data.source,
        businessRequires: business.requireVoicePaymentUpfront,
        env,
      });

      // Advance-payment requires a phone to SMS the link to. Refuse early
      // with a structured error so the voice agent can apologize.
      if (paymentRequired && !data.customerPhone) {
        throw new OrderError(
          'phone_required_for_payment',
          'We need a phone number to text the payment link. Please ask the caller to call back with caller ID enabled.',
          { status: 400 },
        );
      }

      const menuItems = await tx.menuItem.findMany({
        where: { id: { in: menuItemIds }, businessId: data.businessId },
        select: { id: true, price: true, available: true },
      });

      if (menuItems.length !== menuItemIds.length) {
        throw new OrderError(
          'menu_item_not_found',
          'One or more menu items do not belong to this business.',
          { status: 400 },
        );
      }
      const unavailable = menuItems.filter((mi) => !mi.available);
      if (unavailable.length > 0) {
        throw new OrderError('menu_item_unavailable', 'One or more menu items are unavailable.', {
          status: 409,
          details: { ids: unavailable.map((m) => m.id) },
        });
      }

      // Compute total server-side from DB-resolved prices. The client
      // never contributes a monetary value to this calculation.
      const priceById = new Map(menuItems.map((mi) => [mi.id, mi.price]));
      let totalCents = 0n;
      const itemRows = lines.map((line) => {
        const price = priceById.get(line.menuItemId);
        // Prisma returns Decimal — convert to cents via string to avoid
        // float precision loss.
        const priceCents = BigInt(Math.round(Number(price.toString()) * 100));
        totalCents += priceCents * BigInt(line.quantity);
        return {
          menuItemId: line.menuItemId,
          quantity: line.quantity,
          unitPrice: price,
          notes: line.notes,
        };
      });
      const totalAmount = (Number(totalCents) / 100).toFixed(2);

      const createdOrder = await tx.order.create({
        data: {
          businessId: data.businessId,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          type: data.type,
          source: data.source,
          notes: data.notes,
          idempotencyKey: data.idempotencyKey,
          totalAmount,
          // Only voice orders that flow through the advance-payment gate
          // are marked PENDING. Every other order is NOT_REQUIRED and
          // publishes to the kitchen immediately below.
          paymentStatus: paymentRequired ? 'PENDING' : 'NOT_REQUIRED',
          items: { create: itemRows },
        },
        include: { items: { include: { menuItem: true } } },
      });
      return { created: createdOrder, paymentRequired };
    });

    const serialized = serializeOrder(created);

    if (!paymentRequired) {
      // Legacy path: immediately notify the kitchen dashboard.
      publishOrderEvent({
        type: 'order.created',
        businessId: serialized.businessId,
        order: serialized,
      });
      return { order: serialized, created: true };
    }

    // ── Advance-payment path ────────────────────────────────────────────
    // Create the Stripe Checkout Session, persist the id + url on the
    // order, SMS the URL to the caller. The order is intentionally NOT
    // published to the kitchen yet — the Stripe webhook handles that
    // once `checkout.session.completed` arrives.
    try {
      const session = await createStripeSession(serialized);
      const updated = await prisma.order.update({
        where: { id: serialized.id },
        data: {
          stripeSessionId: session.id,
          paymentUrl: session.url,
        },
        include: { items: { include: { menuItem: true } } },
      });
      const updatedSerialized = serializeOrder(updated);
      try {
        await sendPaymentSms({
          toPhone: updatedSerialized.customerPhone,
          paymentUrl: session.url,
          shortCode: updatedSerialized.id.slice(-6).toUpperCase(),
        });
      } catch (smsErr) {
        // SMS failure is bad but not fatal — the order + payment URL
        // still exist and staff can re-surface the link from the admin
        // UI. Log loudly and continue.
        // eslint-disable-next-line no-console
        console.error('[orders.createOrder] SMS dispatch failed', {
          orderId: updatedSerialized.id,
          err: smsErr?.message ?? smsErr,
        });
      }
      return { order: updatedSerialized, created: true };
    } catch (payErr) {
      // Payment infrastructure blew up — mark the order FAILED so staff
      // can see it in ops tooling and follow up, but do NOT publish to
      // the kitchen. Returning the order (vs throwing) keeps the voice
      // agent's ack path intact; the failure is surfaced server-side.
      // eslint-disable-next-line no-console
      console.error('[orders.createOrder] Stripe session creation failed', {
        orderId: serialized.id,
        err: payErr?.message ?? payErr,
      });
      const failed = await prisma.order.update({
        where: { id: serialized.id },
        data: { paymentStatus: 'FAILED' },
        include: { items: { include: { menuItem: true } } },
      });
      return { order: serializeOrder(failed), created: true };
    }
  } catch (err) {
    // Unique-violation on (businessId, idempotencyKey) — another request
    // won the race. Return the winner.
    if (err?.code === 'P2002' && data.idempotencyKey) {
      const existing = await prisma.order.findUnique({
        where: {
          businessId_idempotencyKey: {
            businessId: data.businessId,
            idempotencyKey: data.idempotencyKey,
          },
        },
        include: { items: { include: { menuItem: true } } },
      });
      if (existing) return { order: serializeOrder(existing), created: false };
    }
    throw err;
  }
}

export async function updateOrderStatus(
  { orderId, businessId, status },
  { prisma = defaultPrisma, sendOrderReadySms = defaultSendOrderReadySms } = {},
) {
  const parsed = updateOrderStatusSchema.safeParse({ status });
  if (!parsed.success) {
    throw new OrderError('invalid_input', 'Invalid status.', {
      status: 400,
      details: parsed.error.flatten(),
    });
  }
  const nextStatus = parsed.data.status;

  // Load the current order scoped to the business so we can
  //   (a) confirm the order belongs to this tenant (cross-tenant guard),
  //   (b) validate the transition against the allow-list.
  const current = await prisma.order.findFirst({
    where: { id: orderId, businessId },
    select: { status: true },
  });
  if (!current) {
    // Intentionally indistinguishable from "wrong tenant" — don't leak
    // whether the id exists under another business.
    throw new OrderError('not_found', 'Order not found.', { status: 404 });
  }

  if (current.status !== nextStatus) {
    const allowed = ALLOWED_STATUS_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(nextStatus)) {
      throw new OrderError(
        'invalid_transition',
        `Cannot move order from ${current.status} to ${nextStatus}.`,
        { status: 409 },
      );
    }
  }

  // Conditional update re-checks (status, businessId) atomically so a
  // concurrent update can't sneak in between the read above and the write.
  const result = await prisma.order.updateMany({
    where: { id: orderId, businessId, status: current.status },
    data: { status: nextStatus },
  });
  if (result.count === 0) {
    throw new OrderError('conflict', 'Order changed concurrently, please refresh.', {
      status: 409,
    });
  }

  const updated = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { menuItem: true } } },
  });
  const serialized = serializeOrder(updated);
  publishOrderEvent({
    type: 'order.updated',
    businessId: serialized.businessId,
    order: serialized,
  });

  // ── "Your order is ready" SMS ───────────────────────────────────────
  // Fire-and-forget: the kitchen's status transition has already been
  // committed and published; an SMS failure must not roll back the
  // order or block the operator. We log errors loudly so they surface
  // in ops tooling.
  if (nextStatus === 'READY' && serialized.customerPhone) {
    (async () => {
      try {
        const business = await prisma.business.findUnique({
          where: { id: businessId },
          select: { name: true },
        });
        await sendOrderReadySms({
          toPhone: serialized.customerPhone,
          shortCode: serialized.id.slice(-6).toUpperCase(),
          businessName: business?.name,
        });
      } catch (smsErr) {
        // eslint-disable-next-line no-console
        console.error('[orders.updateOrderStatus] READY SMS failed', {
          orderId,
          err: smsErr?.message ?? smsErr,
        });
      }
    })();
  }

  return serialized;
}

/**
 * Resolve the business the current admin session is allowed to act on.
 *
 * The admin session is not yet multi-tenant (see CLAUDE.md + page.js) — so
 * for now this returns the single active business. The key property: this
 * is resolved SERVER-SIDE from the session, never from a request body.
 * Callers that mutate orders MUST source `businessId` from this helper.
 *
 * When session-scoped tenancy lands, this becomes `return session.businessId`.
 */
export async function resolveActiveBusinessId({ prisma = defaultPrisma } = {}) {
  const business = await prisma.business.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return business?.id ?? null;
}

/**
 * Cancel voice-orders whose advance-payment Checkout Session has been
 * outstanding longer than `olderThanMinutes`. This exists as a backstop
 * for two failure modes:
 *
 *   1. Caller abandonment. Stripe's `checkout.session.expired` webhook
 *      only fires at `expires_at`. Keeping the TTL short (30 min by
 *      default) combined with this sweep means an abandoned order never
 *      dangles as PENDING past the TTL.
 *   2. Webhook delivery hiccups. If Stripe's `session.expired` event
 *      never reaches us (network outage, rotated secret, temporary
 *      signature-verification failure), the order would otherwise sit
 *      forever as PENDING. The sweep closes that gap.
 *
 * The update is a single conditional `updateMany` — concurrent webhook
 * deliveries that race against the sweep do the right thing because
 * both target `paymentStatus = PENDING` exclusively and set the same
 * terminal combo.
 *
 * Returns `{ cancelled: number }`. Designed to be safe to call from a
 * cron job every few minutes: a no-op call is a single indexed query.
 */
export async function sweepExpiredPendingOrders(
  { olderThanMinutes = 30 } = {},
  { prisma = defaultPrisma, now = () => new Date() } = {},
) {
  const cutoff = new Date(now().getTime() - olderThanMinutes * 60 * 1000);
  const result = await prisma.order.updateMany({
    where: {
      paymentStatus: 'PENDING',
      createdAt: { lt: cutoff },
    },
    data: {
      paymentStatus: 'EXPIRED',
      status: 'CANCELLED',
    },
  });
  if (result.count > 0) {
    // eslint-disable-next-line no-console
    console.info('[orders.sweepExpiredPendingOrders] cancelled stale orders', {
      count: result.count,
      olderThanMinutes,
    });
  }
  return { cancelled: result.count };
}

export async function listRecentOrders(
  { businessId, limit = 50 },
  { prisma = defaultPrisma } = {},
) {
  const orders = await prisma.order.findMany({
    where: {
      businessId,
      // Hide orders that are still waiting for (or failed / timed out on)
      // advance payment. The kitchen only ever sees orders whose payment
      // is either NOT_REQUIRED (legacy path) or PAID (webhook-confirmed).
      paymentStatus: { in: ['NOT_REQUIRED', 'PAID'] },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    include: { items: { include: { menuItem: true } } },
  });
  return orders.map(serializeOrder);
}
