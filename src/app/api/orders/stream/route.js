/**
 * GET /api/orders/stream?businessId=... — Server-Sent Events feed for the
 * kitchen dashboard.
 *
 * Auth: admin browser session cookie.
 *
 * Scaling notes
 * -------------
 *   - Runs on the Node runtime (NOT edge). The Edge runtime has short
 *     execution limits on many hosts and does not play well with a
 *     long-lived SSE connection backed by an in-process pub/sub.
 *   - `dynamic = 'force-dynamic'` + no caching are required; a cached or
 *     statically-rendered SSE response would be catastrophic.
 *   - The per-business `subscribe(...)` fan-out lives in `orderEvents.js`.
 *     The default in-process broker works for a single Node; for horizontal
 *     scaling swap it for a Redis/Postgres-backed broker at boot (see
 *     `orderEvents.js`). No changes required in this route.
 *   - A 25s keep-alive comment is emitted to defeat proxy idle timeouts
 *     (many CDNs / load balancers drop idle TCP at ~30s).
 *   - `request.signal` is observed so the subscription + interval are
 *     torn down the moment the client disconnects. Without this, stale
 *     subscribers would accumulate on every page reload.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { subscribeToOrderEvents } from '@/lib/orderEvents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEEP_ALIVE_MS = 25_000;

function sseFormat(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(request) {
  const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const businessId = searchParams.get('businessId');
  if (!businessId) {
    return NextResponse.json({ error: 'businessId query param is required.' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Initial hello — lets the client mark the connection as open.
      safeEnqueue(sseFormat('ready', { businessId, at: Date.now() }));

      const unsubscribe = subscribeToOrderEvents(businessId, (event) => {
        safeEnqueue(sseFormat(event.type, event.order));
      });

      const keepAlive = setInterval(() => {
        // Comment frames are ignored by the EventSource client but keep
        // the socket warm through proxies.
        safeEnqueue(`: keep-alive ${Date.now()}\n\n`);
      }, KEEP_ALIVE_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime — nothing to do.
        }
      };

      // Client disconnect / navigation.
      request.signal.addEventListener('abort', cleanup, { once: true });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx & friends buffer by default — tell them not to for SSE.
      'X-Accel-Buffering': 'no',
    },
  });
}
