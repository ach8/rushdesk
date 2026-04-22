'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALLOWED_STATUS_TRANSITIONS } from '@/lib/orderValidation';

/**
 * Live kitchen dashboard.
 *
 * Connects to `/api/orders/stream` via EventSource. Orders are kept in a
 * Map keyed by id so both `order.created` and `order.updated` events
 * collapse into a single render with no duplicates. Every PATCH is echoed
 * back through the SSE stream by the server, so other operators looking
 * at the same business see the status change land without any extra
 * client-side coordination.
 *
 * Security note
 * -------------
 * The PATCH request intentionally does NOT carry a businessId. The server
 * resolves the admin's active business from the session. An operator at
 * one restaurant cannot address another restaurant's orders even by
 * crafting a request.
 */

const STATUS_STYLES = {
  PENDING: 'bg-amber-100 text-amber-900 ring-amber-200',
  CONFIRMED: 'bg-sky-100 text-sky-900 ring-sky-200',
  PREPARING: 'bg-indigo-100 text-indigo-900 ring-indigo-200',
  READY: 'bg-emerald-100 text-emerald-900 ring-emerald-200',
  COMPLETED: 'bg-slate-200 text-slate-700 ring-slate-300',
  CANCELLED: 'bg-rose-100 text-rose-900 ring-rose-200',
};

// Primary workflow: PENDING → PREPARING → READY → COMPLETED. When the
// kitchen marks an order READY the customer receives an SMS that their
// food is ready to be picked up (handled server-side in updateOrderStatus).
const PRIMARY_ACTION = {
  PENDING: { next: 'PREPARING', label: 'Start preparing', tone: 'indigo' },
  PREPARING: { next: 'READY', label: 'Mark ready', tone: 'amber' },
  READY: { next: 'COMPLETED', label: 'Mark complete', tone: 'emerald' },
};

const TONE_CLASSES = {
  indigo: 'bg-indigo-600 text-white hover:bg-indigo-500 focus-visible:outline-indigo-600',
  amber: 'bg-amber-500 text-white hover:bg-amber-400 focus-visible:outline-amber-500',
  emerald: 'bg-emerald-600 text-white hover:bg-emerald-500 focus-visible:outline-emerald-600',
};

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function OrdersDashboard({ businessId, initialOrders }) {
  const [orders, setOrders] = useState(() => {
    const map = new Map();
    for (const order of initialOrders) map.set(order.id, order);
    return map;
  });
  const [connected, setConnected] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  const upsertOrder = useCallback((order) => {
    setOrders((prev) => {
      const next = new Map(prev);
      next.set(order.id, order);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!businessId) return undefined;
    const url = `/api/orders/stream?businessId=${encodeURIComponent(businessId)}`;
    const es = new EventSource(url, { withCredentials: true });
    esRef.current = es;

    es.addEventListener('ready', () => setConnected(true));
    es.addEventListener('order.created', (ev) => {
      try {
        upsertOrder(JSON.parse(ev.data));
      } catch {
        /* ignore malformed payload */
      }
    });
    es.addEventListener('order.updated', (ev) => {
      try {
        upsertOrder(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [businessId, upsertOrder]);

  const sortedOrders = useMemo(
    () => [...orders.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [orders],
  );

  const requestStatusChange = useCallback(
    async (order, nextStatus) => {
      if (nextStatus === order.status) return;
      setPendingId(order.id);
      setError(null);
      // No optimistic mutation of `status` here — we wait for the
      // server response (which is also what the SSE echo will carry)
      // so the UI cannot diverge from the authoritative kitchen state.
      try {
        const res = await fetch(`/api/orders/${order.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          // No businessId — the server derives it from the session.
          body: JSON.stringify({ status: nextStatus }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error || `Update failed (${res.status})`);
        }
        if (payload.order) upsertOrder(payload.order);
      } catch (err) {
        setError(err.message);
      } finally {
        setPendingId(null);
      }
    },
    [upsertOrder],
  );

  if (!businessId) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        No business is configured yet. Create a Business record in the database to start receiving
        orders.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span
            className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-slate-400'
              }`}
            aria-hidden="true"
          />
          <span>{connected ? 'Live' : 'Reconnecting…'}</span>
          <span aria-hidden="true">·</span>
          <span>{sortedOrders.length} orders</span>
        </div>
        {error ? (
          <p className="text-sm text-rose-600" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {sortedOrders.length === 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm ring-1 ring-slate-900/5">
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 text-5xl">🍽️</div>
            <h2 className="text-lg font-semibold text-slate-700">No orders yet</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-500">
              Orders will appear here in real time as the AI voice assistant takes calls.
            </p>
          </div>
        </section>
      ) : (
        <div className="grid h-[calc(100vh-14rem)] grid-cols-1 gap-6 md:grid-cols-3">
          {/* PENDING COLUMN */}
          <div className="flex h-full flex-col rounded-xl bg-slate-100 p-4">
            <h2 className="mb-4 flex items-center justify-between text-sm font-bold uppercase tracking-widest text-slate-500">
              New / Pending
              <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-xs text-slate-700">
                {sortedOrders.filter((o) => o.status === 'PENDING').length}
              </span>
            </h2>
            <ul className="flex-1 space-y-4 overflow-y-auto pr-1 pb-4">
              {sortedOrders
                .filter((o) => o.status === 'PENDING')
                .map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                  />
                ))}
            </ul>
          </div>

          {/* PREPARING COLUMN */}
          <div className="flex h-full flex-col rounded-xl bg-slate-100 p-4">
            <h2 className="mb-4 flex items-center justify-between text-sm font-bold uppercase tracking-widest text-indigo-500">
              Preparing
              <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs text-indigo-700">
                {sortedOrders.filter((o) => o.status === 'PREPARING').length}
              </span>
            </h2>
            <ul className="flex-1 space-y-4 overflow-y-auto pr-1 pb-4">
              {sortedOrders
                .filter((o) => o.status === 'PREPARING')
                .map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                  />
                ))}
            </ul>
          </div>

          {/* READY COLUMN */}
          <div className="flex h-full flex-col rounded-xl bg-slate-100 p-4">
            <h2 className="mb-4 flex items-center justify-between text-sm font-bold uppercase tracking-widest text-emerald-600">
              Ready / Complete
              <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs text-emerald-700">
                {sortedOrders.filter((o) => ['READY', 'COMPLETED'].includes(o.status)).length}
              </span>
            </h2>
            <ul className="flex-1 space-y-4 overflow-y-auto pr-1 pb-4">
              {sortedOrders
                .filter((o) => ['READY', 'COMPLETED'].includes(o.status))
                .map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                  />
                ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderCard({ order, busy, onChangeStatus }) {
  const action = PRIMARY_ACTION[order.status];
  const allowedNext = ALLOWED_STATUS_TRANSITIONS[order.status] ?? [];
  const canCancel = allowedNext.includes('CANCELLED');
  const terminal = allowedNext.length === 0;

  return (
    <li className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ring-1 ring-slate-900/5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
            #{order.id.slice(-6)} · {order.type}
          </p>
          <h3 className="mt-1 text-base font-semibold text-slate-900">
            {order.customerName || 'Guest'}
          </h3>
          <p className="text-xs text-slate-500">
            {formatTime(order.createdAt)}
            {order.customerPhone ? ` · ${order.customerPhone}` : ''}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[order.status] ?? STATUS_STYLES.PENDING
            }`}
        >
          {order.status}
        </span>
      </div>

      <ul className="mt-4 space-y-2 text-sm text-slate-700">
        {order.items.map((item) => (
          <li key={item.id} className="rounded-lg bg-slate-50/60 px-3 py-2">
            <div className="flex justify-between gap-3">
              <span className="truncate">
                <span className="font-semibold text-slate-900">{item.quantity}×</span>{' '}
                {item.menuItemName ?? 'Item'}
              </span>
              <span className="tabular-nums text-slate-500">
                {formatCurrency(item.unitPrice * item.quantity)}
              </span>
            </div>
            {item.notes ? (
              <p className="mt-1 flex items-start gap-1.5 text-xs font-medium text-amber-800">
                <span aria-hidden="true">▸</span>
                <span>{item.notes}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {order.notes ? (
        <div
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
          role="note"
        >
          <p className="font-semibold uppercase tracking-widest">Order note</p>
          <p className="mt-0.5 italic">{order.notes}</p>
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
        <span className="text-sm font-semibold text-slate-900 tabular-nums">
          {formatCurrency(order.totalAmount)}
        </span>
        <div className="flex items-center gap-2">
          {canCancel ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChangeStatus(order, 'CANCELLED')}
              className="rounded-md px-2.5 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
            >
              Cancel
            </button>
          ) : null}
          {action ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChangeStatus(order, action.next)}
              className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 ${TONE_CLASSES[action.tone]
                }`}
            >
              {busy ? 'Updating…' : action.label}
            </button>
          ) : terminal ? (
            <span className="text-xs font-medium text-slate-400">No further actions</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
