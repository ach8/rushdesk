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
export async function createOrder(input, { prisma = defaultPrisma } = {}) {
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
    const created = await prisma.$transaction(async (tx) => {
      const business = await tx.business.findUnique({
        where: { id: data.businessId },
        select: { id: true },
      });
      if (!business) {
        throw new OrderError('business_not_found', 'Business not found.', {
          status: 404,
        });
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

      return tx.order.create({
        data: {
          businessId: data.businessId,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          type: data.type,
          source: data.source,
          notes: data.notes,
          idempotencyKey: data.idempotencyKey,
          totalAmount,
          items: { create: itemRows },
        },
        include: { items: { include: { menuItem: true } } },
      });
    });

    const serialized = serializeOrder(created);
    publishOrderEvent({
      type: 'order.created',
      businessId: serialized.businessId,
      order: serialized,
    });
    return { order: serialized, created: true };
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
  { prisma = defaultPrisma } = {},
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

export async function listRecentOrders(
  { businessId, limit = 50 },
  { prisma = defaultPrisma } = {},
) {
  const orders = await prisma.order.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
    include: { items: { include: { menuItem: true } } },
  });
  return orders.map(serializeOrder);
}
