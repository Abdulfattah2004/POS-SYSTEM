import { getLowStockProducts, getOutOfStockProducts } from '@/lib/store';
import { AlertTriangle, XCircle } from 'lucide-react';

export default function LowStockAlert() {
  const lowStock = getLowStockProducts(5);
  const outOfStock = getOutOfStockProducts();

  if (lowStock.length === 0 && outOfStock.length === 0) return null;

  return (
    <div className="space-y-2">
      {outOfStock.length > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
          <XCircle size={16} className="text-destructive mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-destructive">Out of Stock ({outOfStock.length})</p>
            <p className="text-xs text-muted-foreground mt-0.5">{outOfStock.map(p => p.name).join(', ')}</p>
          </div>
        </div>
      )}
      {lowStock.length > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-warning/10 border border-warning/20">
          <AlertTriangle size={16} className="text-warning mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-semibold text-warning">Low Stock ({lowStock.length})</p>
            <p className="text-xs text-muted-foreground mt-0.5">{lowStock.map(p => `${p.name} (${p.stockQuantity})`).join(', ')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
