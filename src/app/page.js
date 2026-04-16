import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">RushDesk</h1>
      <p className="max-w-md text-center text-lg text-slate-600">
        AI-powered order and reservation management for restaurants, fast-food chains, and hotels.
      </p>
      <Link
        href="/admin/login"
        className="rounded-lg bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-500"
      >
        Admin Dashboard →
      </Link>
    </main>
  );
}
