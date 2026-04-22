'use server';

import { cookies } from 'next/headers';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { updateOrderStatus, resolveActiveBusinessId, OrderError } from '@/lib/orders';

export async function updateOrderStatusAction(orderId, nextStatus) {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) return { error: 'Unauthorized.' };

    const businessId = await resolveActiveBusinessId();
    if (!businessId) return { error: 'No business is configured.' };

    try {
        const order = await updateOrderStatus({
            orderId,
            businessId,
            status: nextStatus,
        });
        return { order };
    } catch (err) {
        if (err instanceof OrderError) {
            return { error: err.message, code: err.code };
        }
        console.error('[orders.actions] unexpected error', err);
        return { error: 'Failed to update order.' };
    }
}
