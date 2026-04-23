/**
 * POST /api/voice/submit-order — ElevenLabs Conversational AI server-tool
 * webhook.
 *
 * The ElevenLabs agent owns the entire phone conversation (STT, LLM turns,
 * TTS, barge-in). When the caller confirms their order, the agent invokes
 * its `submit_order` server tool, which POSTs JSON to this endpoint.
 *
 * Flow
 * ----
 *   1. Read the **raw** request body and verify the `ElevenLabs-Signature`
 *      header (HMAC-SHA256 over `<timestamp>.<raw_body>`). Anything failing
 *      that check is rejected with 403. This is the ONLY thing that
 *      prevents internet randos from injecting orders.
 *   2. Parse the JSON body. Expected shape (configured on the ElevenLabs
 *      tool):
 *        {
 *          "conversation_id": "<system__conversation_id>",
 *          "caller_phone":    "<system__caller_id>",   // required for rate-limit
 *          "items": [{ "menu_item_id": "...", "quantity": 2, "notes": "..." }],
 *          "order_type": "DINE_IN" | "TAKEAWAY" | "DELIVERY",
 *          "customer_name": "...",                       // optional
 *          "order_notes": "..."                          // optional
 *        }
 *   3. Anti-abuse: normalize the caller's phone number and apply a
 *      per-caller fixed-window rate limit (default 2 attempts / 24h).
 *      Anonymous / withheld caller IDs are refused outright so hiding the
 *      number is not a bypass.
 *   4. **Immediately** return `{ ok: true, status: 'accepted' }` to
 *      ElevenLabs so the agent can confirm to the caller without dead air.
 *      Under peak load `createOrder` can take several seconds; blocking on
 *      it left the caller in silence and made the call feel disconnected.
 *   5. In the background (`waitUntil`), resolve the active business and
 *      dispatch through `executeToolCall` → `createOrder`. `createOrder`
 *      re-validates every menu item, snapshots prices, computes the total,
 *      and `publishOrderEvent` fans the order out to the kitchen-dashboard
 *      SSE stream.
 *
 * Trade-offs of the async ack
 * ---------------------------
 *   - The agent no longer receives a server-computed `total` or
 *     `short_code` to read back. It should say something like
 *     "Got it — your order is on its way to the kitchen."
 *   - If background `createOrder` fails (e.g. an item became unavailable
 *     between confirmation and submit), the caller has already been told
 *     "accepted". The failure is logged server-side; staff see nothing on
 *     the dashboard for that call. This is an intentional latency-vs-
 *     correctness trade accepted for the voice channel.
 *   - Signature verification, JSON parsing, anonymous-caller refusal, and
 *     rate limiting still run **synchronously** before the ack — security
 *     and abuse gates are never deferred.
 *
 * Error-handling philosophy: the caller is live on the phone. We always
 * return HTTP 200 with `{ ok: false, error }` for *application-level*
 * refusals (rate-limit, anonymous caller) so the agent can apologize
 * naturally. We reserve non-2xx for transport / auth failures (bad
 * signature, malformed body).
 */
import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { resolveActiveBusinessId } from '@/lib/orders';
import { verifyElevenLabsSignature } from '@/lib/voice/elevenLabsSignature';
import { executeToolCall } from '@/lib/voice/tools';
import { getVoiceRateLimiter, normalizeCallerKey } from '@/lib/voice/rateLimit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RATE_LIMIT_WINDOW_SECONDS = 24 * 60 * 60;

function approxHours(seconds) {
  return Math.max(1, Math.ceil(seconds / 3600));
}

// Lazily resolve Vercel's `waitUntil` so background work is guaranteed to
// finish after the response is flushed on serverless. Falls back to a
// fire-and-forget promise elsewhere (local dev, long-lived Node server),
// where the process stays alive anyway.
let waitUntilImpl;
async function defaultRunAfterResponse(promise) {
  if (waitUntilImpl === undefined) {
    // Indirect specifier so Vite/Vitest doesn't try to statically resolve
    // an optional dependency at transform time. At runtime on Vercel the
    // package is present; everywhere else we fall through to the fire-and-
    // forget branch below.
    const spec = '@vercel/functions';
    waitUntilImpl = await import(/* @vite-ignore */ /* webpackIgnore: true */ spec)
      .then((m) => m.waitUntil ?? null)
      .catch(() => null);
  }
  if (waitUntilImpl) {
    waitUntilImpl(promise);
  } else {
    // Swallow rejections so an unhandled-rejection cannot crash the worker
    // — the background task already does its own structured logging.
    void promise.catch(() => {});
  }
}

/**
 * Exported handler so unit tests can exercise the full pipeline (signature
 * → rate-limit → async ack → background dispatch) with injected
 * dependencies. The exported `POST` below is the production entrypoint
 * with default deps.
 */
export async function handleSubmitOrder(request, deps = {}) {
  const {
    env: envOverride,
    rateLimiter = getVoiceRateLimiter(),
    resolveBusinessId = resolveActiveBusinessId,
    executeTool = executeToolCall,
    runAfterResponse = defaultRunAfterResponse,
  } = deps;

  let env = envOverride;
  if (!env) {
    try {
      env = getEnv();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[voice.submit-order] env misconfigured', err);
      return NextResponse.json({ ok: false, error: 'Server misconfigured.' }, { status: 500 });
    }
  }

  // The signature is computed over the exact raw bytes ElevenLabs sent.
  // We MUST read `request.text()` (not `.json()`) first, verify, then parse.
  const rawBody = await request.text();

  const sig = verifyElevenLabsSignature({
    rawBody,
    signatureHeader: request.headers.get('elevenlabs-signature'),
    secret: env.ELEVENLABS_WEBHOOK_SECRET,
  });
  if (!sig.ok) {
    // Don't leak which reason — a probing attacker gets nothing useful.
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body.' }, { status: 400 });
  }

  // ── Anti-abuse gate ─────────────────────────────────────────────────
  // Runs AFTER signature verification (only authentic ElevenLabs traffic
  // can touch the counter) and BEFORE we ack the agent.
  // Also check headers in case ElevenLabs passes dynamic variables via headers
  const headerCallerPhone = request.headers.get('x-caller-id');
  const bodyCallerPhone = typeof body?.caller_phone === 'string' ? body.caller_phone : null;
  const callerPhone = headerCallerPhone || bodyCallerPhone;

  const callerKey = normalizeCallerKey(callerPhone);
  if (!callerKey) {
    return NextResponse.json(
      {
        ok: false,
        code: 'caller_id_required',
        error:
          'We can only accept phone orders from numbers with caller ID enabled. ' +
          'Please ask the caller to unblock their number and call back.',
      },
      { status: 200 },
    );
  }

  let gate;
  try {
    gate = await rateLimiter.hit(callerKey, {
      limit: env.VOICE_ORDER_DAILY_LIMIT,
      windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    });
  } catch (err) {
    // A limiter outage must not let abuse through. Fail closed.
    // eslint-disable-next-line no-console
    console.error('[voice.submit-order] rate limiter unavailable', err);
    return NextResponse.json(
      {
        ok: false,
        code: 'rate_limit_unavailable',
        error:
          'We are unable to accept phone orders right now. Apologize and ask the caller to try again shortly.',
      },
      { status: 200 },
    );
  }
  if (!gate.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: 'rate_limited',
        limit: env.VOICE_ORDER_DAILY_LIMIT,
        retry_after_seconds: gate.retryAfterSeconds,
        error:
          `This phone number has already placed ${env.VOICE_ORDER_DAILY_LIMIT} orders today, ` +
          `which is our daily limit. Politely tell the caller we cannot accept another order ` +
          `from this number for about ${approxHours(gate.retryAfterSeconds)} hours, then end the call.`,
      },
      { status: 200, headers: { 'Retry-After': String(gate.retryAfterSeconds) } },
    );
  }
  // ────────────────────────────────────────────────────────────────────

  const headerConversationId = request.headers.get('x-conversation-id');
  const bodyConversationId = typeof body?.conversation_id === 'string' ? body.conversation_id : null;
  const conversationId = headerConversationId || bodyConversationId;

  // Kick off order creation WITHOUT awaiting it. Everything past this
  // point is latency-insensitive from the caller's perspective.
  runAfterResponse(
    (async () => {
      try {
        const businessId = await resolveBusinessId();
        if (!businessId) {
          // eslint-disable-next-line no-console
          console.error('[voice.submit-order] no active business configured', {
            conversationId,
          });
          return;
        }
        const result = await executeTool({
          name: 'submit_order',
          args: body,
          ctx: { businessId, conversationId, callerPhone },
        });
        if (!result?.ok) {
          // The caller has already been told "accepted" — surface this
          // loudly in logs so staff can follow up if needed.
          // eslint-disable-next-line no-console
          console.error('[voice.submit-order] background createOrder rejected', {
            conversationId,
            callerPhone,
            code: result?.code,
            error: result?.error,
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[voice.submit-order] background createOrder threw', {
          conversationId,
          err,
        });
      }
    })(),
  );

  // Instant ack — keeps the ElevenLabs agent responsive on the line.
  return NextResponse.json(
    {
      ok: true,
      status: 'accepted',
      next:
        'Tell the caller their order has been received and is on its way to the kitchen, ' +
        'thank them, then end the call.',
    },
    { status: 202 },
  );
}

export async function POST(request) {
  return handleSubmitOrder(request);
}
