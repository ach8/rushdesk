'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ALLOWED_STATUS_TRANSITIONS } from '@/lib/orderValidation';
import { updateOrderStatusAction } from './actions';

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
  const [dismissedOrderIds, setDismissedOrderIds] = useState(() => new Set());
  const [connected, setConnected] = useState(false);
  const [pendingId, setPendingId] = useState(null);
  const [error, setError] = useState(null);
  const esRef = useRef(null);

  const handleDismiss = useCallback((orderId) => {
    setDismissedOrderIds((prev) => {
      const next = new Set(prev);
      next.add(orderId);
      return next;
    });
  }, []);

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
    () => [...orders.values()]
      .filter((o) => !dismissedOrderIds.has(o.id))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
    [orders, dismissedOrderIds],
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
        const payload = await updateOrderStatusAction(order.id, nextStatus);
        if (payload.error) throw new Error(payload.error);
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
    <div className="flex flex-col flex-1 min-h-0 space-y-3">
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          <span
            className={`inline-block h-2 w-2 rounded-full ${connected ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-slate-400'}`}
            aria-hidden="true"
          />
          <span>{connected ? 'Connection active' : 'Reconnecting…'}</span>
          <span aria-hidden="true">·</span>
          <span>{sortedOrders.length} active orders</span>
        </div>
        {error ? (
          <p className="text-xs font-semibold text-rose-600 bg-rose-50 px-2 py-1 rounded" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      {sortedOrders.length === 0 ? (
        <section className="flex-1 rounded-2xl border border-slate-200 bg-white/50 p-8 shadow-sm ring-1 ring-slate-900/5 backdrop-blur-sm">
          <div className="flex h-full flex-col items-center justify-center py-16 text-center">
            <div className="mb-4 text-5xl opacity-50 animate-bounce">🍽️</div>
            <h2 className="text-lg font-semibold text-slate-700">No active orders</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-500">
              Orders will appear here in real time as the AI voice assistant takes calls.
            </p>
          </div>
        </section>
      ) : (() => {
        const pendingOrders = sortedOrders.filter((o) => o.status === 'PENDING');
        const preparingOrders = sortedOrders.filter((o) => o.status === 'PREPARING');
        const readyOrders = sortedOrders.filter((o) => ['READY', 'COMPLETED'].includes(o.status));

        const maxPendingVisible = 5;
        const visiblePending = pendingOrders.slice(0, maxPendingVisible);
        const hiddenPendingCount = pendingOrders.length - visiblePending.length;

        return (
          <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-3 min-h-0 overflow-hidden">
            {/* PENDING COLUMN */}
            <div className="flex h-full flex-col rounded-xl bg-slate-200/50 p-3 shadow-inner">
              <h2 className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-widest text-slate-500">
                New / Pending
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-slate-700 font-bold shadow-sm">
                  {pendingOrders.length}
                </span>
              </h2>
              <ul className="flex-1 space-y-3 overflow-y-auto pr-1 pb-2 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
                {visiblePending.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                    onDismiss={handleDismiss}
                  />
                ))}
                {hiddenPendingCount > 0 && (
                  <li className="flex items-center justify-center p-3 rounded-xl border border-dashed border-slate-300 bg-slate-100/50">
                    <span className="text-xs font-semibold text-slate-500">
                      + {hiddenPendingCount} commande{hiddenPendingCount > 1 ? 's' : ''} en attente...
                    </span>
                  </li>
                )}
              </ul>
            </div>

            {/* PREPARING COLUMN */}
            <div className="flex h-full flex-col rounded-xl bg-slate-200/50 p-3 shadow-inner">
              <h2 className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-widest text-indigo-500">
                Preparing
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-indigo-700 font-bold shadow-sm">
                  {preparingOrders.length}
                </span>
              </h2>
              <ul className="flex-1 space-y-3 overflow-y-auto pr-1 pb-2 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
                {preparingOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                    onDismiss={handleDismiss}
                  />
                ))}
              </ul>
            </div>

            {/* READY COLUMN */}
            <div className="flex h-full flex-col rounded-xl bg-slate-200/50 p-3 shadow-inner">
              <h2 className="mb-3 flex items-center justify-between text-xs font-bold uppercase tracking-widest text-emerald-600">
                Ready / Complete
                <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-emerald-700 font-bold shadow-sm">
                  {readyOrders.length}
                </span>
              </h2>
              <ul className="flex-1 space-y-3 overflow-y-auto pr-1 pb-2 scrollbar-thin scrollbar-thumb-slate-300 scrollbar-track-transparent">
                {readyOrders.map((order) => (
                  <OrderCard
                    key={order.id}
                    order={order}
                    busy={pendingId === order.id}
                    onChangeStatus={requestStatusChange}
                    onDismiss={handleDismiss}
                  />
                ))}
              </ul>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function OrderCard({ order, busy, onChangeStatus, onDismiss }) {
  const action = PRIMARY_ACTION[order.status];
  const allowedNext = ALLOWED_STATUS_TRANSITIONS[order.status] ?? [];
  const canCancel = allowedNext.includes('CANCELLED');
  const terminal = allowedNext.length === 0;
  const isCompleted = order.status === 'COMPLETED';

  // Calculate waiting time
  const waitMinutes = Math.floor((new Date() - new Date(order.createdAt)) / 60000);
  const isUrgent = order.status === 'PENDING' && waitMinutes > 10;

  return (
    <li className={`flex flex-col rounded-xl border bg-white/90 backdrop-blur-sm p-3 shadow-sm transition-all hover:shadow-md ${isUrgent ? 'border-rose-300 ring-1 ring-rose-200 bg-rose-50/50' : 'border-slate-200 ring-1 ring-slate-900/5'}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900 truncate">
              {order.customerName || 'Guest'}
            </h3>
            <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              #{order.id.slice(-4)}
            </span>
            {isUrgent && (
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-500 flex items-center gap-1 mt-0.5">
            <span className="font-medium text-slate-700">{formatTime(order.createdAt)}</span>
            <span>({waitMinutes}m ago)</span>
            {order.customerPhone ? <span className="truncate">· {order.customerPhone}</span> : ''}
          </p>
        </div>
      </div>

      <ul className="mt-3 space-y-1 text-xs text-slate-700">
        {order.items.map((item) => (
          <li key={item.id} className="rounded bg-slate-50 px-2 py-1.5 flex justify-between gap-2 items-start">
            <span className="leading-tight">
              <span className="font-bold text-slate-900">{item.quantity}×</span>{' '}
              {item.menuItemName ?? 'Item'}
              {item.notes && (
                <span className="block mt-0.5 text-[10px] font-medium text-amber-700 bg-amber-50 rounded px-1 w-max">
                  {item.notes}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {order.notes ? (
        <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900 leading-tight">
          <p className="font-bold uppercase tracking-wider text-[9px] opacity-80 mb-0.5">Note</p>
          <p className="font-medium">{order.notes}</p>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-end pt-2 border-t border-slate-100">
        <div className="flex items-center gap-1.5">
          {canCancel ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChangeStatus(order, 'CANCELLED')}
              className="rounded px-2 py-1 text-[10px] font-bold text-rose-600 hover:bg-rose-50 disabled:opacity-50 transition-colors"
            >
              Cancel
            </button>
          ) : null}
          {action ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onChangeStatus(order, action.next)}
              className={`inline-flex items-center rounded px-2.5 py-1 text-[11px] font-bold shadow-sm disabled:opacity-60 transition-colors ${TONE_CLASSES[action.tone]}`}
            >
              {busy ? '...' : action.label}
            </button>
          ) : isCompleted ? (
            <button
              type="button"
              onClick={() => onDismiss?.(order.id)}
              className="inline-flex items-center rounded px-2.5 py-1 text-[11px] font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 transition-colors shadow-sm"
            >
              Clear
            </button>
          ) : terminal ? (
            <span className="text-[10px] font-medium text-slate-400">Done</span>
          ) : null}
        </div>
      </div>
    </li>
  );
}
