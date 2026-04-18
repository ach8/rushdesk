/**
 * PATCH /api/orders/[id] — update order status from the kitchen dashboard.
 *
 * Auth: admin browser session cookie (signed with ADMIN_API_TOKEN).
 *
 * Tenant isolation
 * ----------------
 * `businessId` is resolved SERVER-SIDE from the admin session via
 * `resolveActiveBusinessId`. It is NOT read from the request body. An
 * operator at restaurant A therefore cannot mutate orders at restaurant
 * B by crafting a request — the allowed-business is sourced from the
 * trusted session, not from untrusted input. `updateOrderStatus` then
 * scopes every read/write to that businessId, so even if an attacker
 * knows another tenant's order id the update affects zero rows.
 *
 * Additionally, `updateOrderStatus` rejects invalid state transitions
 * (e.g. PREPARING → PENDING) and uses an optimistic concurrency check so
 * two operators clicking at once don't silently trample each other.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { updateOrderStatus, resolveActiveBusinessId, OrderError } from '@/lib/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request, { params }) {
  const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
  if (!auth.ok) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }

  const businessId = await resolveActiveBusinessId();
  if (!businessId) {
    return NextResponse.json(
      { error: 'No business is configured for this admin.' },
      { status: 403 },
    );
  }

  try {
    const order = await updateOrderStatus({
      orderId: params.id,
      businessId,
      status: body?.status,
    });
    return NextResponse.json({ order });
  } catch (err) {
    if (err instanceof OrderError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: err.status },
      );
    }
    console.error('[orders.PATCH] unexpected error', err);
    return NextResponse.json({ error: 'Failed to update order.' }, { status: 500 });
  }
}
