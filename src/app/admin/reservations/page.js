import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyAdminSessionValue, ADMIN_SESSION_COOKIE } from '@/lib/adminSession';
import { prisma } from '@/lib/prisma';
import ReservationDashboard from './ReservationDashboard';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reservations · RushDesk Admin' };

export default async function ReservationsPage() {
    const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
    if (!auth.ok) redirect('/admin/login');

    const business = await prisma.business.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { id: true, name: true },
    });

    const reservations = business ? await prisma.reservation.findMany({
        where: { businessId: business.id },
        orderBy: { date: 'asc' },
        take: 100, // Show forthcoming first
    }) : [];

    // Convert Date objects to ISO strings for client components limit
    const serialized = reservations.map(r => ({
        ...r,
        date: r.date.toISOString(),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
    }));

    return (
        <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
            <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
                <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">Reservations</h1>
                        <p className="mt-2 text-sm text-slate-600">Manage table bookings and customer arrivals.</p>
                    </div>
                    <Link href="/admin/orders" className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 hover:bg-slate-50 transition">
                        Back to Orders
                    </Link>
                </header>
                <ReservationDashboard businessId={business?.id} initialReservations={serialized} />
            </div>
        </main>
    );
}
