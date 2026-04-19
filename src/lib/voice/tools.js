/**
 * Tool implementations for the voice AI.
 *
 * The AI never touches the database directly — it calls these functions,
 * which enforce the same server-side invariants as any other order source.
 * In particular, every tool that mutates state is a thin wrapper over the
 * existing `createOrder` pipeline so the data-integrity rules in
 * CLAUDE.md (server-computed totals, price snapshotting, business scoping,
 * allow-listed status transitions) apply uniformly whether the order came
 * from a voice call, the web, or a staff member.
 *
 * Design choices
 * --------------
 *   - CallSid is the idempotency key for submit_order, so a Twilio retry
 *     (or an AI that calls the tool twice) cannot create duplicate orders.
 *   - The tool returns a minimal, spoken-friendly payload: order id, total,
 *     and a compact line list the AI can read back to the caller. It does
 *     NOT return internal fields.
 *   - Errors raised by `createOrder` (invalid items, unavailable items,
 *     etc.) are translated into structured tool responses rather than
 *     thrown — the AI can then apologize naturally instead of the call
 *     collapsing into dead air.
 */
import { createOrder, OrderError } from '@/lib/orders';

/**
 * Tool definitions in OpenAI function-calling format. The schemas are the
 * contract between the AI and our server — extra fields the model
 * hallucinates are simply ignored by the dispatcher.
 */
export const VOICE_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'submit_order',
      description:
        "Finalize the caller's order and send it to the kitchen. " +
        'Only call this AFTER reading back the full order and getting explicit confirmation from the caller.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            description:
              'Ordered line items. Use exact menu_item_id values from the system prompt menu.',
            items: {
              type: 'object',
              properties: {
                menu_item_id: { type: 'string', description: 'The id shown in the menu.' },
                quantity: { type: 'integer', minimum: 1, maximum: 99 },
                notes: {
                  type: 'string',
                  description: 'Per-item special instructions, e.g. "no onions", "extra sauce".',
                },
              },
              required: ['menu_item_id', 'quantity'],
            },
          },
          order_type: {
            type: 'string',
            enum: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'],
            description: 'How the caller wants to receive the order.',
          },
          customer_name: {
            type: 'string',
            description: 'Name to put on the order — ask the caller if unclear.',
          },
          order_notes: {
            type: 'string',
            description:
              'Any notes that apply to the whole order (allergies, delivery instructions, etc.).',
          },
        },
        required: ['items', 'order_type'],
      },
    },
  },
];

function sanitizeString(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Normalize the AI's tool-call payload into the shape `createOrder` expects.
 *
 * The AI is trained to approximate JSON schemas but can still emit sloppy
 * shapes (string quantities, missing required fields). We coerce what we
 * safely can and surface a structured error for the rest — the validation
 * in `orderValidation.js` remains the final authority.
 */
export function normalizeSubmitOrderArgs(args, { session }) {
  const rawItems = Array.isArray(args?.items) ? args.items : [];
  const items = rawItems
    .map((raw) => {
      const qty = Number(raw?.quantity);
      if (!raw?.menu_item_id || !Number.isFinite(qty) || qty <= 0) return null;
      return {
        menuItemId: String(raw.menu_item_id),
        quantity: Math.min(Math.max(Math.round(qty), 1), 99),
        notes: sanitizeString(raw.notes, 200),
      };
    })
    .filter(Boolean);

  return {
    businessId: session.businessId,
    // Capture the caller's phone number automatically — Twilio gives it
    // to us in the `From` parameter. Do NOT trust a number typed by the AI.
    customerPhone: session.from ?? undefined,
    customerName: sanitizeString(args?.customer_name, 120),
    type: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(args?.order_type)
      ? args.order_type
      : 'TAKEAWAY',
    source: 'VOICE',
    notes: sanitizeString(args?.order_notes, 500),
    // CallSid is stable for the life of the call — using it as the
    // idempotency key makes submit_order safe under Twilio retries and
    // also under an over-eager AI that calls the tool twice.
    idempotencyKey: session.callSid,
    items,
  };
}

/**
 * Execute a tool call. Returns an object the caller will serialize back
 * into the model's `tool` message. Never throws for expected failures.
 */
export async function executeToolCall({ name, args, session, deps = {} }) {
  const { createOrderImpl = createOrder } = deps;

  switch (name) {
    case 'submit_order': {
      const payload = normalizeSubmitOrderArgs(args, { session });
      if (payload.items.length === 0) {
        return {
          ok: false,
          error:
            'No valid items in the order. Ask the caller to restate what they want and use menu_item_id values from the system prompt.',
        };
      }

      try {
        const { order, created } = await createOrderImpl(payload);
        return {
          ok: true,
          created,
          order_id: order.id,
          short_code: order.id.slice(-6).toUpperCase(),
          total: order.totalAmount,
          currency: 'USD',
          items: order.items.map((i) => ({
            name: i.menuItemName,
            quantity: i.quantity,
            notes: i.notes ?? null,
          })),
          // Hint to the model: the order is in the kitchen now; wrap up.
          next: 'Confirm the short_code and total to the caller, thank them, then end the call.',
        };
      } catch (err) {
        if (err instanceof OrderError) {
          return {
            ok: false,
            code: err.code,
            error: err.message,
          };
        }
        // Don't leak stack traces into the model context.
        // eslint-disable-next-line no-console
        console.error('[voiceTools.submit_order] unexpected error', err);
        return {
          ok: false,
          error: 'An internal error occurred placing the order. Apologize and offer to try again.',
        };
      }
    }

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}
