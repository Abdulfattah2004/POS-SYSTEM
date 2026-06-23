import { useState, useMemo, useEffect } from 'react';
import { formatCurrency } from '@/lib/store';
import {
  getSalesSql,
  getRefundsSql,
  addPartialRefundSql,
} from '@/lib/sqlStore';
import { useAuth } from '@/contexts/AuthContext';
import { Receipt, Search, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { RefundItem, Sale, Refund } from '@/types/pos';

export default function ReceiptsPage() {
  const { user } = useAuth();

  const [sales, setSales] = useState<Sale[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [search, setSearch] = useState('');
  const [expandedSale, setExpandedSale] = useState<string | null>(null);
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({});
  const [selectedMonth, setSelectedMonth] = useState('');
  const [selectedDay, setSelectedDay] = useState('');

  const loadData = async () => {
    setSales(await getSalesSql());
    setRefunds(await getRefundsSql());
  };

  useEffect(() => {
    loadData().catch(error => {
      console.error('Failed to load receipts:', error);
      alert('Failed to load receipts: ' + error);
    });
  }, []);

  const filteredSales = useMemo(() => {
    let result = sales.filter(s =>
      (s.id ?? '').includes(search) ||
      s.items.some(i => (i.productName ?? '').toLowerCase().includes(search.toLowerCase())) ||
      (s.cashierName ?? '').toLowerCase().includes(search.toLowerCase())
    );

    if (selectedMonth) {
      result = result.filter(s => (s.date ?? '').startsWith(selectedMonth));
    }

    if (selectedDay) {
      result = result.filter(s => (s.date ?? '').startsWith(selectedDay));
    }

    return result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [sales, search, selectedMonth, selectedDay]);

  const toggleExpand = (saleId: string) => {
    setExpandedSale(prev => (prev === saleId ? null : saleId));
    setRefundQuantities({});
  };

  const setRefundQty = (productId: string, qty: number) => {
    setRefundQuantities(prev => ({ ...prev, [productId]: qty }));
  };

  const handlePartialRefund = async (saleId: string) => {
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return;

    const itemsToRefund: RefundItem[] = [];

    for (const item of sale.items) {
      const qty = refundQuantities[item.productId] || 0;

      if (qty > 0) {
        if (qty > item.quantity) {
          toast.error(`Cannot refund more than ${item.quantity} of ${item.productName}`);
          return;
        }

        itemsToRefund.push({
          productId: item.productId,
          productName: item.productName,
          barcode: item.barcode,
          quantity: qty,
          salePrice: item.salePrice,
          purchasePrice: item.purchasePrice,
          currency: item.currency,
        });
      }
    }

    if (itemsToRefund.length === 0) {
      toast.error('Select at least one item to refund');
      return;
    }

    if (!confirm(`Refund ${itemsToRefund.length} item(s)? This will restore stock.`)) return;

    try {
      await addPartialRefundSql(saleId, itemsToRefund, user?.name || '');
      await loadData();

      toast.success('Refund processed successfully');
      setExpandedSale(null);
      setRefundQuantities({});
    } catch (error) {
      console.error('Refund failed:', error);
      alert('Refund failed: ' + error);
    }
  };

  const saleRefunds = (saleId: string) => refunds.filter(r => r.saleId === saleId);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Receipt className="text-primary" size={24} />
          <h2 className="pos-header">All Receipts</h2>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="month"
            className="pos-input"
            value={selectedMonth}
            onChange={e => {
              setSelectedMonth(e.target.value);
              setSelectedDay('');
            }}
            placeholder="Month"
          />

          <input
            type="date"
            className="pos-input"
            value={selectedDay}
            onChange={e => {
              setSelectedDay(e.target.value);
              setSelectedMonth('');
            }}
          />

          <div className="relative w-72">
            <Search
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              size={16}
            />

            <input
              className="pos-input w-full pl-9"
              placeholder="Search receipts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {filteredSales.length === 0 ? (
          <div className="pos-card p-12 text-center text-muted-foreground">
            No receipts found
          </div>
        ) : (
          filteredSales.map(sale => (
            <div key={sale.id} className="pos-card overflow-hidden">
              <button
                onClick={() => toggleExpand(sale.id)}
                className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-4">
                  {expandedSale === sale.id ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}

                  <div className="text-left">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{sale.id.slice(-6)}
                    </span>

                    <p className="text-sm font-medium">
                      {new Date(sale.date).toLocaleDateString()} —{' '}
                      {new Date(sale.date).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-6">
                  <span className="text-xs text-muted-foreground">{sale.cashierName}</span>
                  <span className="text-sm font-semibold">
                    {formatCurrency(sale.total, sale.currency)}
                  </span>

                  {sale.refunded && (
                    <span className="text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded-full font-medium">
                      Fully Refunded
                    </span>
                  )}
                </div>
              </button>

              {expandedSale === sale.id && (
                <div className="border-t border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="pos-table-header">
                        <th className="text-left py-2.5 px-4">Product</th>
                        <th className="text-left py-2.5 px-4">Barcode</th>
                        <th className="text-center py-2.5 px-4">Qty</th>
                        <th className="text-right py-2.5 px-4">Price</th>
                        <th className="text-right py-2.5 px-4">Total</th>
                        {!sale.refunded && (
                          <th className="text-center py-2.5 px-4 w-32">Refund Qty</th>
                        )}
                      </tr>
                    </thead>

                    <tbody>
                      {sale.items.map(item => (
                        <tr key={item.productId} className="border-b border-border">
                          <td className="py-3 px-4 font-medium">{item.productName}</td>
                          <td className="py-3 px-4 font-mono text-xs text-muted-foreground">
                            {item.barcode}
                          </td>
                          <td className="py-3 px-4 text-center">{item.quantity}</td>
                          <td className="py-3 px-4 text-right">
                            ${(Number(item.salePrice) || 0).toFixed(2)}
                          </td>
                          <td className="py-3 px-4 text-right font-medium">
                            $
                            {(
                              (Number(item.salePrice) || 0) *
                              (Number(item.quantity) || 0)
                            ).toFixed(2)}
                          </td>

                          {!sale.refunded && (
                            <td className="py-3 px-4 text-center">
                              <input
                                type="number"
                                min="0"
                                max={item.quantity}
                                value={refundQuantities[item.productId] || 0}
                                onChange={e =>
                                  setRefundQty(
                                    item.productId,
                                    Math.min(+e.target.value, item.quantity)
                                  )
                                }
                                className="pos-input w-16 text-center h-8 text-xs"
                              />
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {saleRefunds(sale.id).length > 0 && (
                    <div className="px-4 py-3 bg-muted/30">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                        Past Refunds
                      </p>

                      {saleRefunds(sale.id).map(r => (
                        <div
                          key={r.id}
                          className="flex items-center justify-between text-xs py-1 text-muted-foreground"
                        >
                          <span>
                            {new Date(r.date).toLocaleString()} —{' '}
                            {r.items
                              .map(i => `${i.productName} (x${i.quantity})`)
                              .join(', ')}
                          </span>

                          <span className="text-destructive font-medium">
                            -{formatCurrency(r.totalRefunded, r.currency)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {!sale.refunded && (
                    <div className="p-4 bg-muted/20 flex justify-end">
                      <button
                        onClick={() => handlePartialRefund(sale.id)}
                        className="pos-btn-destructive text-xs py-2 px-4 h-auto flex items-center gap-2"
                      >
                        <RotateCcw size={14} />
                        Refund Selected Items
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}