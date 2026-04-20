/**
 * Tool implementations for the voice AI.
 *
 * The ElevenLabs Conversational AI agent never touches the database
 * directly — it calls these functions (via the /api/voice/submit-order
 * server-tool webhook), which enforce the same server-side invariants as
 * any other order source. Every tool that mutates state is a thin wrapper
 * over the existing `createOrder` pipeline, so the data-integrity rules in
 * CLAUDE.md (server-computed totals, price snapshotting, business scoping,
 * allow-listed status transitions) apply uniformly whether the order came
 * from a voice call, the web, or a staff member.
 *
 * Design choices
 * --------------
 *   - The ElevenLabs `conversation_id` is the idempotency key for
 *     submit_order, so a webhook retry (or an agent that calls the tool
 *     twice) cannot create duplicate orders.
 *   - The tool returns a minimal, spoken-friendly payload: order id, total,
 *     and a compact line list the agent can read back to the caller. It
 *     does NOT return internal fields.
 *   - Errors raised by `createOrder` (invalid items, unavailable items,
 *     etc.) are translated into structured tool responses rather than
 *     thrown — the agent can then apologize naturally instead of the call
 *     collapsing into dead air.
 */
import { createOrder, OrderError } from '@/lib/orders';

function sanitizeString(value, max) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

/**
 * Normalize the agent's tool-call payload into the shape `createOrder`
 * expects.
 *
 * The agent is configured with a JSON schema in the ElevenLabs dashboard,
 * but the underlying LLM can still emit sloppy shapes (string quantities,
 * missing required fields). We coerce what we safely can and surface a
 * structured error for the rest — the validation in `orderValidation.js`
 * remains the final authority.
 *
 * @param {object} args - raw tool arguments from the agent
 * @param {{ businessId: string, callerPhone?: string|null, conversationId?: string|null }} ctx
 *        Server-resolved call context. `businessId` is NEVER read from the
 *        agent payload; it is resolved server-side by the route handler.
 */
export function normalizeSubmitOrderArgs(args, ctx) {
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
    businessId: ctx.businessId,
    // Caller phone comes from ElevenLabs' telephony layer (system dynamic
    // variable), passed through the server-tool body. Do NOT trust a number
    // typed by the agent inside `args`.
    customerPhone: sanitizeString(ctx.callerPhone, 32),
    customerName: sanitizeString(args?.customer_name, 120),
    type: ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].includes(args?.order_type)
      ? args.order_type
      : 'TAKEAWAY',
    source: 'VOICE',
    notes: sanitizeString(args?.order_notes, 500),
    // conversation_id is stable for the life of the call — using it as the
    // idempotency key makes submit_order safe under ElevenLabs retries and
    // also under an over-eager agent that calls the tool twice.
    idempotencyKey: ctx.conversationId
      ? `elevenlabs:${ctx.conversationId}`.slice(0, 128)
      : undefined,
    items,
  };
}

/**
 * Execute a tool call. Returns an object the route handler will serialize
 * back to the ElevenLabs agent. Never throws for expected failures.
 */
export async function executeToolCall({ name, args, ctx, deps = {} }) {
  const { createOrderImpl = createOrder } = deps;

  switch (name) {
    case 'submit_order': {
      const payload = normalizeSubmitOrderArgs(args, ctx);
      if (payload.items.length === 0) {
        return {
          ok: false,
          error:
            'No valid items in the order. Ask the caller to restate what they want and use menu_item_id values from the menu.',
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
          // Hint to the agent: the order is in the kitchen now; wrap up.
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
        // Don't leak stack traces into the agent context.
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
