'use client';

import { useState } from 'react';
import { saveMenuItem, deleteMenuItem, toggleAvailability } from './actions';

export default function MenuManager({ businessId, initialItems }) {
    const [items, setItems] = useState(initialItems);
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false);

    async function handleToggle(item) {
        const nextState = !item.available;
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, available: nextState } : i)));
        await toggleAvailability(businessId, item.id, nextState);
    }

    async function handleDelete(id) {
        if (!confirm('Are you sure you want to delete this product?')) return;
        setBusy(true);
        await deleteMenuItem(businessId, id);
        setItems((prev) => prev.filter((i) => i.id !== id));
        setBusy(false);
    }

    async function handleSave(e) {
        e.preventDefault();
        setBusy(true);
        const fd = new FormData(e.currentTarget);
        const payload = {
            id: editing?.id,
            name: String(fd.get('name') || ''),
            category: String(fd.get('category') || ''),
            price: Number(fd.get('price')),
            available: fd.get('available') === 'on' || fd.get('available') === 'true',
        };

        await saveMenuItem(businessId, payload);
        window.location.reload();
    }

    return (
        <div>
            <div className="mb-6 flex justify-between items-center">
                <h2 className="text-lg font-medium text-slate-800">Your Products</h2>
                <button onClick={() => setEditing({ available: true })} className="bg-indigo-600 text-white px-4 py-2 rounded-lg shadow font-semibold hover:bg-indigo-500">
                    + Add Item
                </button>
            </div>

            {editing && (
                <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-4">
                    <form onSubmit={handleSave} className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-slate-900/10">
                        <h2 className="mb-5 text-xl font-bold">{editing.id ? 'Edit Item' : 'New Item'}</h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-700">Display Name</label>
                                <input required defaultValue={editing.name} name="name" className="mt-1 block w-full rounded-md border-slate-300 p-2 border focus:ring-indigo-500 focus:border-indigo-500" />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium text-slate-700">Category</label>
                                    <input defaultValue={editing.category} name="category" placeholder="e.g. Burgers" className="mt-1 block w-full rounded-md border-slate-300 p-2 border focus:ring-indigo-500 focus:border-indigo-500" />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium text-slate-700">Price ($)</label>
                                    <input required type="number" step="0.01" defaultValue={editing.price} name="price" className="mt-1 block w-full rounded-md border-slate-300 p-2 border focus:ring-indigo-500 focus:border-indigo-500" />
                                </div>
                            </div>
                            <div className="flex items-center pt-2">
                                <input type="checkbox" id="available" name="available" defaultChecked={editing.id ? editing.available : true} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                                <label htmlFor="available" className="ml-2 text-sm text-slate-700">Item is available to order</label>
                            </div>
                        </div>
                        <div className="mt-8 flex justify-end gap-3">
                            <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-sm font-medium text-slate-600 bg-white border border-slate-300 rounded-lg shadow-sm hover:bg-slate-50">Cancel</button>
                            <button disabled={busy} type="submit" className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg shadow-sm hover:bg-indigo-500 disabled:opacity-50">Save Item</button>
                        </div>
                    </form>
                </div>
            )}

            <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
                <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-semibold text-slate-900">Name</th>
                            <th className="px-6 py-3 text-left text-xs font-semibold text-slate-900">Category</th>
                            <th className="px-6 py-3 text-left text-xs font-semibold text-slate-900">Price</th>
                            <th className="px-6 py-3 text-left text-xs font-semibold text-slate-900">Availability</th>
                            <th className="px-6 py-3 text-right text-xs font-semibold text-slate-900">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                        {items.length === 0 && (
                            <tr><td colSpan="5" className="px-6 py-8 text-center text-slate-500">No menu items yet. Create one above!</td></tr>
                        )}
                        {items.map(item => (
                            <tr key={item.id} className={!item.available ? "bg-slate-50/50 opacity-75" : ""}>
                                <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-slate-900">{item.name}</td>
                                <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-500">{item.category || 'Uncategorized'}</td>
                                <td className="whitespace-nowrap px-6 py-4 text-sm tabular-nums text-slate-600">${item.price.toFixed(2)}</td>
                                <td className="whitespace-nowrap px-6 py-4">
                                    <button onClick={() => handleToggle(item)} className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${item.available ? 'bg-indigo-600' : 'bg-slate-200'}`}>
                                        <span className="sr-only">Toggle availability</span>
                                        <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${item.available ? 'translate-x-5' : 'translate-x-0'}`} />
                                    </button>
                                </td>
                                <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
                                    <button onClick={() => setEditing(item)} className="text-indigo-600 hover:text-indigo-900 mr-4 font-semibold">Edit</button>
                                    <button onClick={() => handleDelete(item.id)} className="text-rose-600 hover:text-rose-900 font-semibold">Delete</button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
