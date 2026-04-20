/**
 * Zod schemas for order mutations.
 *
 * All order mutations MUST pass through a schema here — no ad-hoc inline
 * validation elsewhere. The schemas enforce the trust boundary between
 * untrusted input (voice agent, web client, etc.) and the server.
 *
 * Notably, the create-order schema intentionally does NOT accept a total,
 * unit price, or any monetary value. Pricing is resolved server-side from
 * the MenuItem table inside the creation transaction.
 */
import { z } from 'zod';

const ORDER_TYPES = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'];
const ORDER_SOURCES = ['VOICE', 'WEB', 'STAFF'];
const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED'];

// Bound quantities so a runaway caller cannot construct arbitrarily large
// orders that blow up the server-side total computation or the DB.
const MAX_ITEM_QUANTITY = 99;
const MAX_LINE_ITEMS = 50;

const cuid = z.string().min(1).max(64);

export const createOrderSchema = z.object({
  businessId: cuid,
  customerName: z.string().trim().min(1).max(120).optional(),
  customerPhone: z
    .string()
    .trim()
    .min(3)
    .max(32)
    // Accept E.164-ish input; full normalization happens upstream.
    .regex(/^\+?[0-9 ()-]+$/, 'Invalid phone number')
    .optional(),
  type: z.enum(ORDER_TYPES).default('DINE_IN'),
  source: z.enum(ORDER_SOURCES).default('VOICE'),
  notes: z.string().trim().max(500).optional(),
  // Scoped per-business; enforced unique at the DB layer. A repeated call
  // with the same key returns the existing order instead of creating a new one.
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
  items: z
    .array(
      z.object({
        menuItemId: cuid,
        quantity: z.number().int().positive().max(MAX_ITEM_QUANTITY),
        // Per-item special instructions (e.g. "no onions", "extra sauce").
        // Bounded so a runaway agent can't stuff prompts into the DB.
        notes: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_LINE_ITEMS),
});

// Status transitions allowed from the kitchen dashboard. Server-side
// enforcement prevents an operator from jumping to an inconsistent state
// (e.g. PREPARING → PENDING) via a crafted request.
export const ALLOWED_STATUS_TRANSITIONS = {
  PENDING: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'COMPLETED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  READY: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
});

// Exposed for tests and for UI affordances (e.g. dropdown options).
export const ORDER_STATUS_VALUES = ORDER_STATUSES;
export const ORDER_TYPE_VALUES = ORDER_TYPES;
export const ORDER_SOURCE_VALUES = ORDER_SOURCES;
