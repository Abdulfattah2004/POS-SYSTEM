import { useState } from 'react';
import { deleteInventoryEntry, getInventoryEntries, updateInventoryEntry } from '@/lib/store';
import { useAuth } from '@/contexts/AuthContext';
import { Users, Search, Pencil, Trash2 } from 'lucide-react';
import { InventoryEntry } from '@/types/pos';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import { syncPendingInventory } from '@/lib/inventorySync';

export default function SalesmenPage() {
  const { toast, feedback } = useActionFeedback();
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState(() => getInventoryEntries());
  const [editEntry, setEditEntry] = useState<InventoryEntry | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { isAdmin } = useAuth();

  // Edit form state
  const [editForm, setEditForm] = useState({
    salesmanName: '',
    date: '',
    time: '',
    quantityAdded: 0,
    purchasePrice: 0,
    salePrice: 0,
  });

  const refresh = () => setEntries(getInventoryEntries());

  const openEdit = (e: InventoryEntry) => {
    const d = new Date(e.date);
    setEditForm({
      salesmanName: e.salesmanName,
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      time: d.toTimeString().slice(0, 5),
      quantityAdded: e.quantityAdded,
      purchasePrice: e.purchasePrice,
      salePrice: e.salePrice,
    });
    setEditEntry(e);
  };

  const saveEdit = async () => {
    if (!editEntry) return;
    if (editForm.quantityAdded <= 0) { toast.error('Quantity must be positive'); return; }
    if (editForm.purchasePrice < 0 || editForm.salePrice < 0) { toast.error('Prices must be valid'); return; }
    if (!editForm.date || !editForm.time) { toast.error('Date and time required'); return; }
    if (!editForm.salesmanName.trim()) { toast.error('Salesman name required'); return; }

    try {
    const newDate = new Date(`${editForm.date}T${editForm.time}:00`).toISOString();
    const operationId = await updateInventoryEntry(editEntry.id, {
      salesmanName: editForm.salesmanName.trim(),
      date: newDate,
    });
    setEditEntry(null);
    refresh();
    const confirmed = await syncPendingInventory();
    if (operationId && confirmed.includes(operationId)) {
      toast.success('Record updated and synced with Supabase');
    } else {
      toast.info('Record updated on this device; Supabase sync is pending');
    }
    } catch (error) { toast.error(String(error)); }
  };

  const confirmDelete = async () => {
    if (!deleteId) return;
    try {
    const operationId = await deleteInventoryEntry(deleteId);
    setDeleteId(null);
    refresh();
    const confirmed = await syncPendingInventory();
    if (operationId && confirmed.includes(operationId)) {
      toast.success('Record deleted and synced with Supabase');
    } else {
      toast.info('Record removed on this device; Supabase sync is pending');
    }
    } catch (error) { toast.error(String(error)); }
  };

  // Group by salesman
  const salesmenMap = new Map<string, typeof entries>();
  entries.forEach(e => {
    const name = e.salesmanName || 'Unknown';
    if (!salesmenMap.has(name)) salesmenMap.set(name, []);
    salesmenMap.get(name)!.push(e);
  });

  const salesmenNames = Array.from(salesmenMap.keys()).filter(name =>
    name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Users className="text-primary" size={24} />
          <h2 className="pos-header">Salesmen</h2>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input className="pos-input w-full pl-9" placeholder="Search salesman..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {feedback}
      {salesmenNames.length === 0 ? (
        <div className="pos-card p-12 text-center text-muted-foreground">No salesmen found</div>
      ) : salesmenNames.map(name => {
        const items = salesmenMap.get(name)!.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        const totalQty = items.reduce((s, e) => s + e.quantityAdded, 0);
        const totalValue = items.reduce((s, e) => s + e.purchasePrice * e.quantityAdded, 0);

        return (
          <div key={name} className="pos-card overflow-hidden mb-4">
            <div className="flex items-center justify-between p-4 bg-muted/30">
              <div>
                <h3 className="font-semibold text-foreground">{name}</h3>
                <p className="text-xs text-muted-foreground">{items.length} entries · {totalQty} items · ${totalValue.toFixed(2)} total cost</p>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="pos-table-header">
                  <th className="text-left py-2.5 px-4">Product</th>
                  <th className="text-left py-2.5 px-4">Barcode</th>
                  <th className="text-left py-2.5 px-4">Date</th>
                  <th className="text-left py-2.5 px-4">Time</th>
                  <th className="text-right py-2.5 px-4">Qty</th>
                  <th className="text-right py-2.5 px-4">Purchase $</th>
                  <th className="text-right py-2.5 px-4">Sale $</th>
                  {isAdmin && <th className="text-center py-2.5 px-4">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {items.map(e => (
                  <tr key={e.id} className="border-b border-border">
                    <td className="py-3 px-4 font-medium">{e.productName}</td>
                    <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{e.barcode}</td>
                    <td className="py-3 px-4 text-muted-foreground">{new Date(e.date).toLocaleDateString()}</td>
                    <td className="py-3 px-4 text-muted-foreground">{new Date(e.date).toLocaleTimeString()}</td>
                    <td className="py-3 px-4 text-right">{e.quantityAdded}</td>
                    <td className="py-3 px-4 text-right">${e.purchasePrice.toFixed(2)}</td>
                    <td className="py-3 px-4 text-right">${e.salePrice.toFixed(2)}</td>
                    {isAdmin && (
                      <td className="py-3 px-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(e)} title="Edit">
                            <Pencil size={15} />
                          </Button>
                          <Button variant="ghost" size="icon" className="text-destructive hover:text-destructive" disabled onClick={() => setDeleteId(e.id)} title="Delete">
                            <Trash2 size={15} />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* Edit Dialog */}
      <Dialog open={!!editEntry} onOpenChange={open => !open && setEditEntry(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Record</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <label className="text-sm font-medium text-foreground">Salesman Name</label>
              <Input value={editForm.salesmanName} onChange={e => setEditForm(f => ({ ...f, salesmanName: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Date</label>
                <Input type="date" value={editForm.date} onChange={e => setEditForm(f => ({ ...f, date: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Time</label>
                <Input type="time" value={editForm.time} onChange={e => setEditForm(f => ({ ...f, time: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium text-foreground">Quantity</label>
              <Input type="number" disabled min={1} value={editForm.quantityAdded} onChange={e => setEditForm(f => ({ ...f, quantityAdded: Number(e.target.value) }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium text-foreground">Purchase Price</label>
                <Input type="number" disabled min={0} step="0.01" value={editForm.purchasePrice} onChange={e => setEditForm(f => ({ ...f, purchasePrice: Number(e.target.value) }))} />
              </div>
              <div>
                <label className="text-sm font-medium text-foreground">Sale Price</label>
                <Input type="number" disabled min={0} step="0.01" value={editForm.salePrice} onChange={e => setEditForm(f => ({ ...f, salePrice: Number(e.target.value) }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditEntry(null)}>Cancel</Button>
            <Button onClick={saveEdit}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to delete this record? This will only remove the salesman entry — products and inventory will not be affected.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
