import Link from 'next/link';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ADMIN_SESSION_COOKIE, verifyAdminSessionValue } from '@/lib/adminSession';
import { prisma } from '@/lib/prisma';
import { getBusinessSettings, missingAdvancePaymentEnv } from '@/lib/businessSettings';
import { signOutAdmin } from '../login/actions';
import SettingsForm from './SettingsForm';

export const metadata = {
  title: 'Settings · RushDesk Admin',
  description: 'Configure how the AI voice receptionist handles incoming orders.',
};

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const auth = verifyAdminSessionValue(cookies().get(ADMIN_SESSION_COOKIE)?.value);
  if (!auth.ok) {
    redirect('/admin/login');
  }

  // Same single-tenant resolution as /admin/orders — picks the earliest
  // business as the active one. Swapped out once session-scoped tenancy
  // lands.
  const business = await prisma.business.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });

  const settings = business ? await getBusinessSettings(business.id) : null;
  const missingEnv = missingAdvancePaymentEnv();
  const paymentEnvConfigured = missingEnv.length === 0;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8 lg:py-14">
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">
              RushDesk · Admin{business ? ` · ${business.name}` : ''}
            </p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
              Settings
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-slate-600">
              Configure how the AI voice receptionist accepts orders.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/orders"
              className="inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
            >
              ← Dashboard
            </Link>
            <form action={signOutAdmin}>
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-lg bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-inset ring-slate-300 transition hover:bg-slate-50"
              >
                Sign out
              </button>
            </form>
          </div>
        </header>

        {business ? (
          <SettingsForm
            initialRequireVoicePaymentUpfront={Boolean(settings?.requireVoicePaymentUpfront)}
            paymentEnvConfigured={paymentEnvConfigured}
            missingEnv={missingEnv}
          />
        ) : (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            No business is configured yet. Create a Business record in the database first.
          </div>
        )}
      </div>
    </main>
  );
}
