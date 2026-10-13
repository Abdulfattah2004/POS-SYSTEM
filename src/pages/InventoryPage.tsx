import { useState } from 'react';
import { getProducts, updateProduct, deleteProduct } from '@/lib/store';
import { useAuth } from '@/contexts/AuthContext';
import { Product } from '@/types/pos';
import { Package, Search, Edit2, Check, X, Trash2 } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import { getLegacyInventoryDiscoveryError, getLegacyInventoryReadView, getLocalState, inventoryOwnershipVerified, originalBelongsToSelectedBranch, visibleBranch } from '@/lib/localDatabase';

export default function InventoryPage() {
  const { toast, feedback } = useActionFeedback();
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [page,setPage]=useState(0);
  const [showArchived,setShowArchived]=useState(false);
  const [saving,setSaving]=useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<Product>>({});
  const [, setRefresh] = useState(0);

  const durableProducts=showArchived?visibleBranch().products:getProducts();
  const unassignedLegacyPreview=!showArchived&&!inventoryOwnershipVerified()&&!originalBelongsToSelectedBranch()?getLegacyInventoryReadView():null;
  const legacyView=durableProducts.length===0?unassignedLegacyPreview:null;
  const products = (legacyView?.products??durableProducts).filter(p =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.barcode.includes(search)
  );
  const pageCount=Math.max(1,Math.ceil(products.length/50));
  const currentPage=Math.min(page,pageCount-1);
  const visible=products.slice(currentPage*50,(currentPage+1)*50);

  const startEdit = (p: Product) => {
    setEditingId(p.id);
    setEditData({ name:p.name, barcode:p.barcode, stockQuantity: p.stockQuantity, salePrice: p.salePrice, purchasePrice: p.purchasePrice });
  };

  const saveEdit = async (id: string) => {
    if(saving)return;
    setSaving(true);
    try {
    await updateProduct(id, editData);
    setEditingId(null);
    setRefresh(r => r + 1);
    toast.success('Product updated');
    } catch (error) { toast.error(String(error)); } finally {setSaving(false);}
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Package className="text-primary" size={24} />
          <h2 className="pos-header">Inventory ({products.length})</h2>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input
            className="pos-input w-full pl-9"
            placeholder="Search by name or barcode..."
            value={search}
            onChange={e => {setSearch(e.target.value);setPage(0);}}
          />
        </div>
      </div>

      {legacyView&&<div role="status" className="mb-3 rounded border border-amber-400 p-3 text-sm">Read-only preview from {legacyView.sourcePath}: {legacyView.productCount} products and stock {legacyView.stockQuantitySum}. These products are not active in {getLocalState().association?.branchName??'the selected branch'} and cannot be sold or edited yet. An administrator can restore them in Settings after the authorized cloud inventory baseline matches.</div>}
      {!legacyView&&unassignedLegacyPreview&&<section aria-label="Unassigned legacy inventory preview" className="mb-4 rounded border border-amber-400 p-3">
        <h3 className="font-semibold">Original inventory preview - not active in this branch</h3>
        <p className="text-sm mb-2">Read-only source: {unassignedLegacyPreview.sourcePath}. {unassignedLegacyPreview.productCount} original products; combined stock {unassignedLegacyPreview.stockQuantitySum}. These quantities are not part of the selected branch's available stock. Review and activate them in Settings only after the authorized cloud inventory baseline matches.</p>
        <div className="max-h-64 overflow-auto"><table className="w-full text-sm"><thead><tr><th className="text-left">Barcode</th><th className="text-left">Product</th><th className="text-right">Original stock</th></tr></thead><tbody>{unassignedLegacyPreview.products.filter(p=>p.name.toLowerCase().includes(search.toLowerCase())||p.barcode.includes(search)).map(p=><tr key={p.id} className="border-t"><td className="py-1 font-mono">{p.barcode}</td><td className="py-1">{p.name}</td><td className="py-1 text-right">{p.stockQuantity}</td></tr>)}</tbody></table></div>
      </section>}
      {getLegacyInventoryDiscoveryError()&&<p role="alert" className="mb-4 rounded border border-destructive p-3 text-sm">Original inventory could not be safely inspected: {getLegacyInventoryDiscoveryError()} No database was chosen or changed. Review the source databases in Settings before proceeding.</p>}
      <label className="flex gap-2 mb-3"><input type="checkbox" checked={showArchived} onChange={e=>{setShowArchived(e.target.checked);setPage(0);}}/>Include archived products</label>
      {feedback}
      <div className="pos-card overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="pos-table-header">
              <th className="text-left py-3 px-4">Barcode</th>
              <th className="text-left py-3 px-4">Name</th>
              <th className="text-right py-3 px-4">Stock</th>
              <th className="text-right py-3 px-4">Purchase $</th>
              <th className="text-right py-3 px-4">Sale $</th>
              <th className="text-right py-3 px-4">Margin</th>
              {isAdmin && !legacyView && <th className="py-3 px-4 w-20">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {products.length === 0 ? (
              <tr>
                <td colSpan={legacyView?6:7} className="text-center py-12 text-muted-foreground">
                  No products found. Add items through the Inventory Entry page.
                </td>
              </tr>
            ) : visible.map(p => {
              const margin = p.salePrice - p.purchasePrice;
              // Correct margin %: (Selling - Cost) / Selling × 100
              const marginPercent = p.salePrice > 0 ? ((margin / p.salePrice) * 100).toFixed(1) : '0.0';
              return (
                <tr key={p.id} className="border-b border-border hover:bg-muted/30">
                  <td className="py-3 px-4 font-mono text-xs">{editingId===p.id ? <input aria-label="Barcode" className="pos-input w-32" value={editData.barcode} onChange={e=>setEditData({...editData,barcode:e.target.value})}/> : p.barcode}</td>
                  <td className="py-3 px-4 font-medium">{editingId===p.id ? <input aria-label="Product name" className="pos-input w-40" value={editData.name} onChange={e=>setEditData({...editData,name:e.target.value})}/> : p.name}{p.isActive===false&&<span className="block text-muted-foreground text-xs">Archived</span>}</td>
                  <td className="py-3 px-4 text-right">
                    {editingId === p.id ? (
                      <input type="number" className="pos-input w-20 text-right" value={editData.stockQuantity} onChange={e => setEditData({ ...editData, stockQuantity: +e.target.value })} />
                    ) : (
                      <span className={p.stockQuantity <= 5 ? 'text-destructive font-semibold' : ''}>{p.stockQuantity}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {editingId === p.id ? (
                      <input type="number" step="0.01" className="pos-input w-24 text-right" value={editData.purchasePrice} onChange={e => setEditData({ ...editData, purchasePrice: +e.target.value })} />
                    ) : `$${p.purchasePrice.toFixed(2)}`}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {editingId === p.id ? (
                      <input type="number" step="0.01" className="pos-input w-24 text-right" value={editData.salePrice} onChange={e => setEditData({ ...editData, salePrice: +e.target.value })} />
                    ) : `$${p.salePrice.toFixed(2)}`}
                  </td>
                  <td className="py-3 px-4 text-right text-success font-medium">
                    {marginPercent}%
                  </td>
                  {isAdmin && !legacyView && (
                    <td className="py-3 px-4 text-center">
                      {editingId === p.id ? (
                        <div className="flex gap-1 justify-center">
                          <button aria-label={`Save ${p.name}`} disabled={saving} onClick={() => saveEdit(p.id)} className="p-1.5 text-success hover:bg-success/10 rounded"><Check size={14} /></button>
                          <button aria-label="Cancel product edit" disabled={saving} onClick={() => setEditingId(null)} className="p-1.5 text-destructive hover:bg-destructive/10 rounded"><X size={14} /></button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-center">
                          <button aria-label={`Edit ${p.name}`} onClick={() => startEdit(p)} className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded">
                            <Edit2 size={14} />
                          </button>
                          <button
                            aria-label={`Archive ${p.name}`}
                            onClick={async () => {
                              if (confirm(`Archive "${p.name}"? Stock and transaction history will be retained.`)) {
                                try {
                                await deleteProduct(p.id);
                                setRefresh(r => r + 1);
                                toast.success('Product archived');
                                } catch (error) { toast.error(String(error)); }
                              }
                            }}
                            className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex gap-4 items-center mt-4"><button className="pos-btn-secondary" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous</button><span>Page {currentPage+1} of {pageCount}</span><button className="pos-btn-secondary" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>Next</button></div>
    </div>
  );
}
