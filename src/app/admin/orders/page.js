import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { prisma } from '@/lib/prisma';
import { listRecentOrders } from '@/lib/orders';
import { signOutAdmin } from '../login/actions';
import OrdersDashboard from './OrdersDashboard';

export const metadata = {
  title: 'Orders · RushDesk Admin',
  description: 'Manage incoming orders from the AI voice assistant and track kitchen progress.',
};

export const dynamic = 'force-dynamic';

export default async function OrdersPage() {
  const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
  if (!auth.ok) {
    redirect('/admin/login');
  }

  // The current admin session is not yet business-scoped; pick the earliest
  // business as the active tenant. When multi-tenant auth lands the session
  // payload will carry `businessId` and this lookup goes away.
  const business = await prisma.business.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  const initialOrders = business
    ? await listRecentOrders({ businessId: business.id, limit: 50 })
    : [];

  return (
    <main className="h-screen overflow-hidden bg-gradient-to-b from-slate-50 to-slate-100 flex flex-col">
      <div className="flex-1 w-full px-4 py-4 sm:px-6 lg:px-8 flex flex-col h-full">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between shrink-0">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-indigo-600 mb-1">
              RushDesk · {business ? business.name : 'Kitchen'}
            </p>
            <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl flex items-center gap-3">
              Live Orders
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-2 sm:mt-0">
            <Link
              href="/admin/menu"
              className="inline-flex items-center justify-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
            >
              Menu
            </Link>
            <Link
              href="/admin/reservations"
              className="inline-flex items-center justify-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
            >
              Reservations
            </Link>
            <Link
              href="/admin/orders/history"
              className="inline-flex items-center justify-center rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 shadow-sm ring-1 ring-inset ring-indigo-200 transition hover:bg-indigo-100"
            >
              History
            </Link>
            <Link
              href="/admin/settings"
              className="inline-flex items-center justify-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
            >
              Settings
            </Link>
            <form action={signOutAdmin}>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        <OrdersDashboard businessId={business?.id ?? null} initialOrders={initialOrders} />
      </div>
    </main>
  );
}
