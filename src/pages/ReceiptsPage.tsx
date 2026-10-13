import { useState, useRef,useMemo,useSyncExternalStore } from 'react';
import {getLocalRevision,subscribeLocalState} from '@/lib/localDatabase';
import { getSales, getRefunds, formatCurrency, addPartialRefund, remainingQuantity, isFullyRefunded, createTransactionId } from '@/lib/store';
import { useAuth } from '@/contexts/AuthContext';
import { Receipt, Search, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import { RefundItem } from '@/types/pos';
import {useDurableOperation} from '@/hooks/useDurableOperation';

export default function ReceiptsPage() {
  const { toast, feedback } = useActionFeedback();
  const busy = useRef(false);
  const { user } = useAuth();
  const operation=useDurableOperation('receipt-refund',(payload:{saleId:string;items:RefundItem[];cashierName:string},id:string)=>addPartialRefund(payload.saleId,payload.items,payload.cashierName,id));
  const [search, setSearch] = useState('');
  const [page,setPage]=useState(0);
  const [expandedSale, setExpandedSale] = useState<string | null>(null);
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({});
  const [, setRefresh] = useState(0);

  const revision=useSyncExternalStore(subscribeLocalState,getLocalRevision,getLocalRevision);
  const {sales,refunds}=useMemo(()=>{
    if(revision<0)throw new Error('Local database is not ready.');
    return {sales:getSales(),refunds:getRefunds()};
  },[revision]);

  const filteredSales = sales.filter(s =>
    s.id.includes(search) ||
    s.items.some(i => i.productName.toLowerCase().includes(search.toLowerCase())) ||
    s.cashierName.toLowerCase().includes(search.toLowerCase())
  ).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const pageCount=Math.max(1,Math.ceil(filteredSales.length/50));
  const currentPage=Math.min(page,pageCount-1);

  const toggleExpand = (saleId: string) => {
    setExpandedSale(prev => prev === saleId ? null : saleId);
    setRefundQuantities({});
  };

  const setRefundQty = (productId: string, qty: number) => {
    setRefundQuantities(prev => ({ ...prev, [productId]: qty }));
  };

  const handlePartialRefund = async (saleId: string) => {
    if (busy.current) return;
    if(operation.pending){
      busy.current=true;
      try{await operation.execute(operation.pending.payload);toast.success('Saved refund confirmed.');setRefresh(r=>r+1);}catch(error){toast.error(String(error));}finally{busy.current=false;}
      return;
    }
    const sale = sales.find(s => s.id === saleId);
    if (!sale) return;

    const itemsToRefund: RefundItem[] = [];
    for (const item of sale.items) {
      const qty = refundQuantities[item.productId] || 0;
      if (qty > 0) {
        if (qty > remainingQuantity(sale, item.productId)) {
          toast.error(`Cannot refund more than ${remainingQuantity(sale, item.productId)} of ${item.productName}`);
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

    busy.current = true;
    try {
    await operation.execute({saleId,items:itemsToRefund,cashierName:user?.name || ''});
    toast.success('Refund saved on this device. Cloud confirmation is required before payout.');
    setExpandedSale(null);
    setRefundQuantities({});
    setRefresh(r => r + 1);
    } catch (error) { toast.error(String(error)); }
    finally { busy.current = false; }
  };

  const saleRefunds = (saleId: string) => refunds.filter(r => r.saleId === saleId);

  return (
    <div className="p-6">
      {operation.error&&<p role="alert">{operation.error}</p>}
      {operation.pending&&<div role="alert" className="pos-card p-4">A refund needs confirmation. <button className="pos-btn-primary" onClick={()=>handlePartialRefund(operation.pending!.payload.saleId)}>Retry saved refund</button></div>}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Receipt className="text-primary" size={24} />
          <h2 className="pos-header">All Receipts</h2>
        </div>
        <div className="relative w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
          <input className="pos-input w-full pl-9" placeholder="Search receipts..." value={search} onChange={e => {setSearch(e.target.value);setPage(0);}} />
        </div>
      </div>

      {feedback}
      <div className="space-y-3">
        {filteredSales.length === 0 ? (
          <div className="pos-card p-12 text-center text-muted-foreground">No receipts found</div>
        ) : filteredSales.slice(currentPage*50,currentPage*50+50).map(sale => (
          <div key={sale.id} className="pos-card overflow-hidden">
            {/* Receipt header */}
            <button
              onClick={() => toggleExpand(sale.id)}
              className="w-full flex items-center justify-between p-4 hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-center gap-4">
                {expandedSale === sale.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <div className="text-left">
                  <span className="font-mono text-xs text-muted-foreground">#{sale.id.slice(-6)}</span>
                  <p className="text-sm font-medium">
                    {new Date(sale.date).toLocaleDateString()} — {new Date(sale.date).toLocaleTimeString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <span className="text-xs text-muted-foreground">{sale.cashierName}</span>
                <span className="text-sm font-semibold">{formatCurrency(sale.total, sale.currency)}</span>
                {sale.legacy && <span className="text-xs bg-warning/10 px-2 py-0.5 rounded-full">Unverified legacy history</span>}
                {!sale.legacy && isFullyRefunded(sale) && (
                  <span className="text-xs bg-destructive/10 text-destructive px-2 py-0.5 rounded-full font-medium">Fully Refunded</span>
                )}
              </div>
            </button>

            {/* Expanded: items */}
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
                      {!sale.legacy && !isFullyRefunded(sale) && <th className="text-center py-2.5 px-4 w-32">Refund Qty</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {sale.items.map(item => (
                      <tr key={item.productId} className="border-b border-border">
                        <td className="py-3 px-4 font-medium">{item.productName}</td>
                        <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{item.barcode}</td>
                        <td className="py-3 px-4 text-center">{item.quantity}</td>
                        <td className="py-3 px-4 text-right">${item.salePrice.toFixed(2)}</td>
                        <td className="py-3 px-4 text-right font-medium">${(item.salePrice * item.quantity).toFixed(2)}</td>
                        {!sale.legacy && !isFullyRefunded(sale) && (
                          <td className="py-3 px-4 text-center">
                            <input
                              type="number"
                              min="0"
                              max={remainingQuantity(sale, item.productId)}
                              value={refundQuantities[item.productId] || 0}
                              onChange={e => setRefundQty(item.productId, Math.min(+e.target.value, remainingQuantity(sale, item.productId)))}
                              className="pos-input w-16 text-center h-8 text-xs"
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Refund history for this sale */}
                {saleRefunds(sale.id).length > 0 && (
                  <div className="px-4 py-3 bg-muted/30">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Past Refunds</p>
                    {saleRefunds(sale.id).map(r => (
                      <div key={r.id} className="flex items-center justify-between text-xs py-1 text-muted-foreground">
                        <span>{new Date(r.date).toLocaleString()} — {r.items.map(i => `${i.productName} (x${i.quantity})`).join(', ')}</span>
                        <span className="text-destructive font-medium">-{formatCurrency(r.totalRefunded, r.currency)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {!sale.legacy && !isFullyRefunded(sale) && (
                  <div className="p-4 bg-muted/20 flex justify-end">
                    <button onClick={() => handlePartialRefund(sale.id)} className="pos-btn-destructive text-xs py-2 px-4 h-auto flex items-center gap-2">
                      <RotateCcw size={14} />
                      Refund Selected Items
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-3 mt-4"><button className="pos-btn-secondary" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>Previous receipts</button><span>{filteredSales.length.toLocaleString('en-US')} receipts · Page {currentPage+1} of {pageCount}</span><button className="pos-btn-secondary" disabled={currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>Next receipts</button></div>
    </div>
  );
}
