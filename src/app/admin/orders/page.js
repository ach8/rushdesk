import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { signOutAdmin } from '../login/actions';

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

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">
              RushDesk · Admin
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Kitchen Dashboard
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
              Orders placed through the AI voice assistant appear here in real time.
              Update statuses as orders move through preparation and delivery.
            </p>
          </div>
          <form action={signOutAdmin}>
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
            >
              Sign out
            </button>
          </form>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm ring-1 ring-slate-900/5">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 text-5xl">🍽️</div>
            <h2 className="text-lg font-semibold text-slate-700">No orders yet</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-500">
              Orders will appear here once the AI voice assistant starts taking calls.
              The dashboard updates in real time via Server-Sent Events.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
