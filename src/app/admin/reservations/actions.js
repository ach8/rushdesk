'use server';

import { cookies } from 'next/headers';
import { verifyAdminSessionValue, ADMIN_SESSION_COOKIE } from '@/lib/adminSession';
import { prisma } from '@/lib/prisma';
import { revalidatePath } from 'next/cache';

export async function updateReservationStatus(businessId, reservationId, status) {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) return { error: 'Unauthorized' };

    try {
        await prisma.reservation.update({
            where: { id: reservationId, businessId },
            data: { status }
        });
        revalidatePath('/admin/reservations');
        return { success: true };
    } catch (err) {
        return { error: 'Failed to update status' };
    }
}
