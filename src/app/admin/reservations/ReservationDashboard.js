'use client';

import { useState } from 'react';
import { updateReservationStatus } from './actions';

export default function ReservationDashboard({ businessId, initialReservations }) {
    const [reservations, setReservations] = useState(initialReservations);
    const [busyId, setBusyId] = useState(null);

    async function handleStatusChange(id, nextStatus) {
        setBusyId(id);
        await updateReservationStatus(businessId, id, nextStatus);
        setReservations(prev => prev.map(r => r.id === id ? { ...r, status: nextStatus } : r));
        setBusyId(null);
    }

    function formatTime(iso) {
        return new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    const statusColors = {
        PENDING: 'bg-amber-100 text-amber-800',
        CONFIRMED: 'bg-indigo-100 text-indigo-800',
        COMPLETED: 'bg-slate-200 text-slate-700',
        CANCELLED: 'bg-rose-100 text-rose-800',
        NO_SHOW: 'bg-red-100 text-red-900',
    };

    return (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {reservations.map(res => (
                <div key={res.id} className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
                    <div className="flex justify-between items-start">
                        <div>
                            <h3 className="font-bold text-lg text-slate-900">{res.customerName}</h3>
                            <p className="mt-1 text-sm font-semibold text-slate-500">Party of {res.partySize}</p>
                        </div>
                        <span className={`text-xs font-bold px-2 py-1 tracking-wider rounded-md ${statusColors[res.status] || 'bg-slate-100'}`}>
                            {res.status}
                        </span>
                    </div>
                    <div className="mt-4 flex-1 text-sm text-slate-700 space-y-1.5">
                        <p className="flex items-center gap-2">
                            <span role="img" aria-label="time">🕒</span> {formatTime(res.date)}
                        </p>
                        {res.customerPhone && (
                            <p className="flex items-center gap-2">
                                <span role="img" aria-label="phone">📞</span> {res.customerPhone}
                            </p>
                        )}
                        {res.notes && (
                            <div className="mt-3 rounded border border-slate-100 bg-slate-50 p-2 text-xs text-slate-600">
                                <strong className="block text-slate-700">Notes:</strong> {res.notes}
                            </div>
                        )}
                    </div>

                    <div className="mt-6 flex flex-wrap gap-2 pt-4 border-t border-slate-100">
                        {res.status === 'PENDING' && (
                            <button disabled={busyId === res.id} onClick={() => handleStatusChange(res.id, 'CONFIRMED')} className="bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg px-3 py-2 text-xs font-semibold shadow flex-1 disabled:opacity-50 transition">Confirm Booking</button>
                        )}
                        {(res.status === 'PENDING' || res.status === 'CONFIRMED') && (
                            <button disabled={busyId === res.id} onClick={() => handleStatusChange(res.id, 'COMPLETED')} className="bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-2 text-xs font-semibold shadow flex-1 disabled:opacity-50 transition">Mark Arrived</button>
                        )}
                        {res.status !== 'CANCELLED' && res.status !== 'NO_SHOW' && res.status !== 'COMPLETED' && (
                            <button disabled={busyId === res.id} onClick={() => handleStatusChange(res.id, 'CANCELLED')} className="bg-white border rounded-lg px-3 py-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 flex-1 disabled:opacity-50 transition">Cancel</button>
                        )}
                    </div>
                </div>
            ))}
            {reservations.length === 0 && (
                <div className="col-span-full py-16 text-center text-slate-500 bg-white rounded-2xl border border-slate-200">
                    No upcoming reservations.
                </div>
            )}
        </div>
    );
}
