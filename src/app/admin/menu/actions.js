'use server';

import { cookies } from 'next/headers';
import { verifyAdminSessionValue, ADMIN_SESSION_COOKIE } from '@/lib/adminSession';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';

const menuItemSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1, 'Name is required'),
    category: z.string().optional(),
    price: z.coerce.number().min(0, 'Price must be positive'),
    available: z.boolean().default(true),
});

export async function saveMenuItem(businessId, formData) {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) return { error: 'Unauthorized' };

    if (!businessId) return { error: 'No business selected' };

    const parsed = menuItemSchema.safeParse(formData);
    if (!parsed.success) return { error: 'Invalid data', details: parsed.error.flatten() };

    const data = parsed.data;

    try {
        if (data.id) {
            await prisma.menuItem.update({
                where: { id: data.id, businessId },
                data: {
                    name: data.name,
                    category: data.category,
                    price: data.price,
                    available: data.available,
                }
            });
        } else {
            await prisma.menuItem.create({
                data: {
                    businessId,
                    name: data.name,
                    category: data.category,
                    price: data.price,
                    available: data.available,
                }
            });
        }
        revalidatePath('/admin/menu');
        return { success: true };
    } catch (err) {
        return { error: 'Database error' };
    }
}

export async function deleteMenuItem(businessId, itemId) {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) return { error: 'Unauthorized' };

    try {
        await prisma.menuItem.delete({
            where: { id: itemId, businessId }
        });
        revalidatePath('/admin/menu');
        return { success: true };
    } catch (err) {
        return { error: 'Failed to delete' };
    }
}

export async function toggleAvailability(businessId, itemId, available) {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) return { error: 'Unauthorized' };

    try {
        await prisma.menuItem.update({
            where: { id: itemId, businessId },
            data: { available }
        });
        revalidatePath('/admin/menu');
        return { success: true };
    } catch (err) {
        return { error: 'Failed to update' };
    }
}
