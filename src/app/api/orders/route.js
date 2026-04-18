/**
 * POST /api/orders — create an order.
 *
 * Auth: Bearer ADMIN_API_TOKEN. Order creation is a server-to-server flow
 * (the AI voice agent / internal services call in), NOT a public endpoint.
 * Keeping it token-gated prevents anonymous callers from injecting orders.
 *
 * The request body is validated against `createOrderSchema`. Notably, no
 * monetary field is accepted — pricing is resolved from the DB inside a
 * transaction. See `src/lib/orders.js` for the integrity invariants.
 */
import { NextResponse } from 'next/server';
import { verifyAdminApiToken } from '@/lib/adminAuth';
import { createOrder, OrderError } from '@/lib/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const auth = verifyAdminApiToken(request.headers.get('authorization'));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  try {
    const { order, created } = await createOrder(body);
    return NextResponse.json({ order, created }, { status: created ? 201 : 200 });
  } catch (err) {
    if (err instanceof OrderError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status },
      );
    }
    // Avoid leaking internal error messages/stack to callers.
    console.error('[orders.POST] unexpected error', err);
    return NextResponse.json({ error: 'Failed to create order.' }, { status: 500 });
  }
}
