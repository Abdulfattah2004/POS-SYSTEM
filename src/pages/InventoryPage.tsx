import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  getProductsSql,
  updateProductSql,
  deleteProductSql,
  getInventoryEntriesSql,
  updateLatestInventoryEntrySalesmanSql,
} from '@/lib/sqlStore';
import { useAuth } from '@/contexts/AuthContext';
import { Product, InventoryEntry } from '@/types/pos';
import { Package, Search, Edit2, Check, X, Trash2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import LowStockAlert from '@/components/LowStockAlert';

export default function InventoryPage() {
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editData, setEditData] = useState<Partial<Product> & { salesmanName?: string }>({});
  const [products, setProducts] = useState<Product[]>([]);
  const [inventoryEntries, setInventoryEntries] = useState<InventoryEntry[]>([]);

  const loadData = useCallback(async () => {
    setProducts(await getProductsSql());
    setInventoryEntries(await getInventoryEntriesSql());
  }, []);

  useEffect(() => {
    loadData().catch(error => {
      console.error('Failed to load inventory:', error);
      alert('Failed to load inventory: ' + error);
    });
  }, [loadData]);

  useEffect(() => {
    const handleFocus = () => {
      loadData().catch(console.error);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        loadData().catch(console.error);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadData]);

  const filteredProducts = useMemo(() => {
    return products.filter(p =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.barcode.includes(search)
    );
  }, [products, search]);

  const getSalesmanForProduct = (_productId: string, barcode: string) => {
    const entries = inventoryEntries.filter(e => e.barcode === barcode);
    if (entries.length === 0) return '';

    const latest = [...entries].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    )[0];

    return latest.salesmanName || '';
  };

  const startEdit = (p: Product) => {
    setEditingId(p.id);
    setEditData({
      name: p.name,
      stockQuantity: p.stockQuantity,
      salePrice: p.salePrice,
      purchasePrice: p.purchasePrice,
      salesmanName: getSalesmanForProduct(p.id, p.barcode),
    });
  };

  const saveEdit = async (id: string) => {
    try {
      const product = products.find(p => p.id === id);
      if (!product) return;

      const { salesmanName, ...productUpdates } = editData;

      await updateProductSql(id, productUpdates);

      if (salesmanName !== undefined) {
        await updateLatestInventoryEntrySalesmanSql(product.barcode, salesmanName);
      }

      await loadData();
      setEditingId(null);
      toast.success('Product updated');
    } catch (error) {
      console.error('Failed to update product:', error);
      alert('Failed to update product: ' + error);
    }
  };

  const handleDelete = async (p: Product) => {
    if (!confirm(`Delete "${p.name}" from inventory?`)) return;

    try {
      await deleteProductSql(p.id);
      await loadData();
      toast.success('Product removed');
    } catch (error) {
      console.error('Failed to delete product:', error);
      alert('Failed to delete product: ' + error);
    }
  };

  return (
    <div className="p-6">
      {isAdmin && (
        <div className="mb-4">
          <LowStockAlert />
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Package className="text-primary" size={24} />
          <h2 className="pos-header">Inventory ({filteredProducts.length})</h2>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="pos-btn-secondary flex items-center gap-2"
            onClick={() => loadData()}
          >
            <RefreshCw size={14} />
            Refresh
          </button>

          <div className="relative w-72">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
            <input
              className="pos-input w-full pl-9"
              placeholder="Search by name or barcode..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="pos-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="pos-table-header">
              <th className="text-left py-3 px-4">Barcode</th>
              <th className="text-left py-3 px-4">Name</th>
              <th className="text-left py-3 px-4">Salesman</th>
              <th className="text-right py-3 px-4">Stock</th>
              <th className="text-right py-3 px-4">Purchase $</th>
              <th className="text-right py-3 px-4">Sale $</th>
              <th className="text-right py-3 px-4">Margin</th>
              {isAdmin && <th className="py-3 px-4 w-20">Actions</th>}
            </tr>
          </thead>

          <tbody>
            {filteredProducts.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center py-12 text-muted-foreground">
                  No products found. Add items through the Inventory Entry page.
                </td>
              </tr>
            ) : (
              filteredProducts.map(p => {
                const purchasePrice = Number(p.purchasePrice) || 0;
                const salePrice = Number(p.salePrice) || 0;

                const marginPercent =
                  purchasePrice > 0
                    ? (((salePrice - purchasePrice) / purchasePrice) * 100).toFixed(1)
                    : '0.0';

                return (
                  <tr key={p.id} className="border-b border-border hover:bg-muted/30">
                    <td className="py-3 px-4 font-mono text-xs">{p.barcode}</td>

                    <td className="py-3 px-4 font-medium">
                      {editingId === p.id ? (
                        <input
                          className="pos-input w-36"
                          value={editData.name || ''}
                          onChange={e => setEditData({ ...editData, name: e.target.value })}
                          placeholder="Name"
                        />
                      ) : (
                        p.name
                      )}
                    </td>

                    <td className="py-3 px-4">
                      {editingId === p.id ? (
                        <input
                          className="pos-input w-28"
                          value={editData.salesmanName || ''}
                          onChange={e =>
                            setEditData({ ...editData, salesmanName: e.target.value })
                          }
                          placeholder="Salesman"
                        />
                      ) : (
                        <span className="text-muted-foreground text-xs">
                          {getSalesmanForProduct(p.id, p.barcode) || '—'}
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right">
                      {editingId === p.id ? (
                        <input
                          type="number"
                          className="pos-input w-20 text-right"
                          value={editData.stockQuantity}
                          onChange={e =>
                            setEditData({ ...editData, stockQuantity: +e.target.value })
                          }
                        />
                      ) : (
                        <span className={p.stockQuantity <= 5 ? 'text-destructive font-semibold' : ''}>
                          {p.stockQuantity}
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right">
                      {editingId === p.id ? (
                        <input
                          type="number"
                          step="0.01"
                          className="pos-input w-24 text-right"
                          value={editData.purchasePrice}
                          onChange={e =>
                            setEditData({ ...editData, purchasePrice: +e.target.value })
                          }
                        />
                      ) : (
                        `$${purchasePrice.toFixed(2)}`
                      )}
                    </td>

                    <td className="py-3 px-4 text-right">
                      {editingId === p.id ? (
                        <input
                          type="number"
                          step="0.01"
                          className="pos-input w-24 text-right"
                          value={editData.salePrice}
                          onChange={e =>
                            setEditData({ ...editData, salePrice: +e.target.value })
                          }
                        />
                      ) : (
                        `$${salePrice.toFixed(2)}`
                      )}
                    </td>

                    <td className="py-3 px-4 text-right text-success font-medium">
                      {marginPercent}%
                    </td>

                    {isAdmin && (
                      <td className="py-3 px-4 text-center">
                        {editingId === p.id ? (
                          <div className="flex gap-1 justify-center">
                            <button
                              onClick={() => saveEdit(p.id)}
                              className="p-1.5 text-success hover:bg-success/10 rounded"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="p-1.5 text-destructive hover:bg-destructive/10 rounded"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-center">
                            <button
                              onClick={() => startEdit(p)}
                              className="p-1.5 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button
                              onClick={() => handleDelete(p)}
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
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
