import { useState, useRef } from 'react';
import { addInventoryEntry, getTodayStr, createTransactionId } from '@/lib/store';
import { useAuth } from '@/contexts/AuthContext';
import { PackagePlus } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import { syncPendingInventory } from '@/lib/inventorySync';
import {useDurableOperation} from '@/hooks/useDurableOperation';

export default function InventoryEntryPage() {
  const { toast, feedback } = useActionFeedback();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const operation=useDurableOperation('inventory',addInventoryEntry);
  const { user } = useAuth();
  const [form, setForm] = useState({
    productName: '',
    barcode: '',
    quantityAdded: '',
    purchasePrice: '',
    salePrice: '',
    salesmanName: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    if (!operation.pending && (!form.productName || !form.barcode || !form.quantityAdded || !form.purchasePrice || !form.salePrice)) {
      toast.error('Please fill all required fields');
      return;
    }

    busy.current = true; setSaving(true);
    try {
    const payload=operation.pending?.payload ?? {
      productId: '',
      productName: form.productName,
      barcode: form.barcode,
      quantityAdded: Number(form.quantityAdded),
      purchasePrice: Number(form.purchasePrice),
      salePrice: Number(form.salePrice),
      salesmanName: form.salesmanName || user?.name || '',
      date: new Date().toISOString(),
    };
    const entry = await operation.execute(payload);

    const confirmed = await syncPendingInventory();
    if (confirmed.includes(entry.id)) {
      toast.success(`Added ${form.quantityAdded}x ${form.productName} and synced with Supabase`);
    } else {
      toast.info(`Saved ${form.quantityAdded}x ${form.productName} on this device; Supabase sync is pending`);
    }
    setForm({ productName: '', barcode: '', quantityAdded: '', purchasePrice: '', salePrice: '', salesmanName: '' });
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { busy.current = false; setSaving(false); }
  };

  const update = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-3 mb-6">
        <PackagePlus className="text-primary" size={24} />
        <h2 className="pos-header">Add Inventory Entry</h2>
      </div>

      <form onSubmit={handleSubmit} className="pos-card p-6">
        {feedback}
        {operation.error&&<p role="alert">{operation.error}</p>}
        {operation.pending&&<div role="alert">A receipt needs confirmation. <button type="submit" disabled={saving} className="pos-btn-primary">Retry saved receipt</button></div>}
        <fieldset disabled={saving || Boolean(operation.pending) || Boolean(operation.error)} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Item Name *</label>
            <input className="pos-input w-full" value={form.productName} onChange={e => update('productName', e.target.value)} placeholder="Product name" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Barcode *</label>
            <input className="pos-input w-full" value={form.barcode} onChange={e => update('barcode', e.target.value)} placeholder="Scan or enter barcode" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Quantity *</label>
            <input type="number" className="pos-input w-full" value={form.quantityAdded} onChange={e => update('quantityAdded', e.target.value)} placeholder="0" min="1" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Purchase Price ($) *</label>
            <input type="number" step="0.01" className="pos-input w-full" value={form.purchasePrice} onChange={e => update('purchasePrice', e.target.value)} placeholder="0.00" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Sale Price ($) *</label>
            <input type="number" step="0.01" className="pos-input w-full" value={form.salePrice} onChange={e => update('salePrice', e.target.value)} placeholder="0.00" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Salesman Name</label>
            <input className="pos-input w-full" value={form.salesmanName} onChange={e => update('salesmanName', e.target.value)} placeholder="Salesman" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">Date</label>
            <input className="pos-input w-full" value={getTodayStr()} disabled />
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={saving} className="pos-btn-primary">Add to Inventory</button>
          <button type="button" className="pos-btn-secondary" onClick={() => setForm({ productName: '', barcode: '', quantityAdded: '', purchasePrice: '', salePrice: '', salesmanName: '' })}>
            Clear
          </button>
        </div>
        </fieldset>
      </form>
    </div>
  );
}
