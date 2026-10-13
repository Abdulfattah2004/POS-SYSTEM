import { useState, useRef, useEffect, useCallback } from 'react';
import { getRefunds, remainingQuantity, createTransactionId, formatCurrency, getRefundableItemsByBarcode, getExchangeRate, convertCurrency } from '@/lib/store';
import { useAuth } from '@/contexts/AuthContext';
import { AlertTriangle, RotateCcw, ScanBarcode, Trash2, Plus, Minus } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import { Product, Currency } from '@/types/pos';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import { addRefundBatch, type RefundRequest } from '@/lib/store';
import {useDurableOperation} from '@/hooks/useDurableOperation';

import {settlementPreview} from '@/lib/settlement';

interface RefundCartItem {
  product: Product;
  quantity: number;
  saleId: string;
  maxQuantity: number;
  salePrice: number;
  purchasePrice: number;
}

export default function RefundsPage() {
  const { toast, feedback } = useActionFeedback();
  const { user } = useAuth();
  const [cart, setCart] = useState<RefundCartItem[]>([]);
  const [barcode, setBarcode] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const barcodeRef = useRef<HTMLInputElement>(null);
  const rate = getExchangeRate();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const operation=useDurableOperation('refund-batch',(payload:{requests:RefundRequest[];cashierName:string;currency:Currency;exchangeRate:number},id:string)=>addRefundBatch(payload.requests,payload.cashierName,payload.currency,payload.exchangeRate,id));
  const refunds = getRefunds();

  useEffect(() => {
    barcodeRef.current?.focus();
  }, []);

  const addToRefundCart = useCallback((code: string) => {
    if (busy.current || operation.pending || operation.error) return;
    let match: ReturnType<typeof getRefundableItemsByBarcode>[number] | undefined;
    try {
      match = getRefundableItemsByBarcode(code).find(candidate => candidate.remaining >
        (cart.find(item => item.saleId === candidate.sale.id && item.product.id === candidate.product.id)?.quantity ?? 0));
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Refund identity could not be resolved.'); return; }
    if (!match) {
      toast.error('No sale found with this product to refund');
      return;
    }
    const { product, sale: eligibleSale, item: saleItem } = match;

    setCart(prev => {
      const existing = prev.find(c => c.saleId === eligibleSale.id && c.product.id === product.id);
      if (existing) {
        if (existing.quantity >= existing.maxQuantity) {
          toast.error('Max refund quantity reached for this sale');
          return prev;
        }
        return prev.map(c =>
          c.saleId === eligibleSale.id && c.product.id === product.id
            ? { ...c, quantity: c.quantity + 1 }
            : c
        );
      }
      return [...prev, {
        product,
        quantity: 1,
        saleId: eligibleSale.id,
        maxQuantity: remainingQuantity(eligibleSale, saleItem.productId),
        salePrice: saleItem.salePrice,
        purchasePrice: saleItem.purchasePrice,
      }];
    });

    toast.success(`Refund: ${product.name}`);
  }, [cart,operation.pending,operation.error,toast]);

  useBarcodeScanner(addToRefundCart);

  const handleBarcodeScan = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && barcode.trim()) {
      e.preventDefault();
      addToRefundCart(barcode);
      setBarcode('');
    }
  };

  const updateQty = (productId: string, saleId: string, newQty: number) => {
    if (busy.current || operation.pending || operation.error) return;
    if (!Number.isSafeInteger(newQty) || newQty < 1 || newQty > 2147483647) { toast.error('Refund quantity must be a positive whole number.'); return; }
    setCart(prev => prev.map(c => {
      if (c.product.id !== productId || c.saleId !== saleId) return c;
      if (newQty <= 0) return c;
      if (newQty > c.maxQuantity) {
        toast.error('Cannot exceed sold quantity');
        return c;
      }
      return { ...c, quantity: newQty };
    }));
  };

  const removeItem = (productId: string, saleId: string) => {
    if (busy.current || operation.pending || operation.error) return;
    setCart(prev => prev.filter(c => !(c.product.id === productId && c.saleId === saleId)));
  };

  const refundCurrency=operation.pending?.payload.currency ?? currency;
  const refundRate=operation.pending?.payload.exchangeRate ?? rate;
  const previewLines=operation.pending?.payload.requests.flatMap(request=>request.items.map(item=>({...item,saleId:request.saleId}))) ?? cart;
  const {subtotal,total}=settlementPreview(previewLines,refundCurrency,refundRate);

  const completeRefund = async () => {
    if (busy.current) return;
    if (cart.length === 0 && !operation.pending) {
      toast.error('Refund cart is empty');
      return;
    }

    if (!confirm(`Process refund of ${formatCurrency(total, refundCurrency)}? This will restore stock.`)) return;

    // Group by saleId
    const bySale = cart.reduce<Record<string, RefundCartItem[]>>((acc, item) => {
      if (!acc[item.saleId]) acc[item.saleId] = [];
      acc[item.saleId].push(item);
      return acc;
    }, {});

    busy.current = true; setSaving(true);
    try {
    await operation.execute(operation.pending?.payload ?? { requests:Object.entries(bySale).map(([saleId, items]) => ({
      saleId, items: items.map(i => ({ productId: i.product.id, productName: i.product.name,
        barcode: i.product.barcode, quantity: i.quantity, salePrice: i.salePrice,
        purchasePrice: i.purchasePrice, currency }))
    })), cashierName:user?.name || '', currency, exchangeRate:rate });

    toast.success('Refund saved on this device. Cloud confirmation is required before payout.');
    setCart([]);
    barcodeRef.current?.focus();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Refund was not committed.'); }
    finally { busy.current = false; setSaving(false); }
  };

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: 'hsl(0, 40%, 97%)' }}>
      {/* REFUND MODE BANNER */}
      <div className="sticky top-0 z-50 bg-destructive text-destructive-foreground px-6 py-4 flex items-center gap-3 shadow-lg">
        <AlertTriangle size={28} className="animate-pulse" />
        <span className="text-xl font-bold tracking-wide">⚠️ REFUND MODE ACTIVE</span>
        <AlertTriangle size={28} className="animate-pulse" />
      </div>

      <div className="flex flex-1 overflow-hidden">
        {operation.error&&<p role="alert">{operation.error}</p>}
        {operation.pending&&<div role="alert" className="p-4">A refund needs confirmation. <button className="pos-btn-primary" disabled={saving} onClick={completeRefund}>Retry saved refund</button></div>}
        {/* Left: Scanner + Cart */}
        <div className="flex-1 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-6">
            <ScanBarcode className="text-destructive" size={24} />
            <h2 className="text-xl font-bold text-destructive">Scan Items to Refund</h2>
          </div>

          {feedback}
          {/* Barcode Input */}
          <div className="mb-6">
            <div className="flex gap-3">
              <input
                ref={barcodeRef}
                data-barcode-input="true"
                className="pos-input flex-1 border-destructive/30 focus:ring-destructive/50"
                placeholder="Scan barcode or type product code..."
                value={barcode}
                onChange={e => setBarcode(e.target.value)}
                onKeyDown={handleBarcodeScan}
              />
              <button
                className="bg-destructive text-destructive-foreground px-4 py-2 rounded-lg font-medium hover:bg-destructive/90 transition-colors"
                onClick={() => { addToRefundCart(barcode); setBarcode(''); }}
              >
                Add
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-1.5">Scan product barcode to add to refund cart</p>
          </div>

          {/* Refund Cart Items */}
          <div className="flex-1 overflow-auto">
            {cart.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                <RotateCcw size={48} className="mb-3 opacity-30" />
                <p className="text-sm">Refund cart is empty</p>
                <p className="text-xs mt-1">Scan items to refund</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-destructive/10 text-destructive">
                    <th className="text-left py-2.5 px-3 font-semibold">Item</th>
                    <th className="text-center py-2.5 px-3 font-semibold">Qty</th>
                    <th className="text-right py-2.5 px-3 font-semibold">Price</th>
                    <th className="text-right py-2.5 px-3 font-semibold">Total</th>
                    <th className="py-2.5 px-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {cart.map(c => (
                    <tr key={`${c.saleId}-${c.product.id}`} className="border-b border-destructive/10">
                      <td className="py-3 px-3">
                        <p className="font-medium">{c.product.name}</p>
                        <p className="text-xs text-muted-foreground">{c.product.barcode}</p>
                        <p className="text-xs text-destructive/60">Sale #{c.saleId.slice(-6)}</p>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center justify-center gap-1.5">
                          <button onClick={() => updateQty(c.product.id, c.saleId, c.quantity - 1)} className="p-1 rounded hover:bg-destructive/10">
                            <Minus size={14} />
                          </button>
                          <input
                            type="number"
                            min="1"
                            max={c.maxQuantity}
                            value={c.quantity}
                            onChange={e => updateQty(c.product.id, c.saleId, Math.max(1, +e.target.value))}
                            className="w-12 text-center font-medium bg-transparent border border-destructive/20 rounded px-1 py-0.5 text-sm"
                          />
                          <button onClick={() => updateQty(c.product.id, c.saleId, c.quantity + 1)} className="p-1 rounded hover:bg-destructive/10">
                            <Plus size={14} />
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-right text-muted-foreground">${c.salePrice.toFixed(2)}</td>
                      <td className="py-3 px-3 text-right font-medium">${(c.salePrice * c.quantity).toFixed(2)}</td>
                      <td className="py-3 px-3">
                        <button onClick={() => removeItem(c.product.id, c.saleId)} className="p-1 text-destructive hover:bg-destructive/10 rounded">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: Summary */}
        <div className="w-80 border-l border-destructive/20 bg-white p-6 flex flex-col">
          <h3 className="text-lg font-bold text-destructive mb-6">Refund Summary</h3>

          {/* Currency Toggle */}
          <div className="flex rounded-lg border border-destructive/20 overflow-hidden mb-6">
            {(['USD', 'LBP'] as Currency[]).map(c => (
              <button
                key={c}
                disabled={saving||Boolean(operation.pending)||Boolean(operation.error)}
                onClick={() => setCurrency(c)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  refundCurrency === c ? 'bg-destructive text-destructive-foreground' : 'bg-white text-muted-foreground hover:bg-destructive/5'
                }`}
              >
                {c === 'USD' ? '$ USD' : 'L.L LBP'}
              </button>
            ))}
          </div>

          {/* Recent Refunds */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-destructive mb-2">Recent Refunds ({refunds.length})</p>
            <div className="space-y-1 max-h-24 overflow-auto">
              {[...refunds].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 3).map(r => (
                <div key={r.id} className="text-xs text-muted-foreground py-1">
                  <span>{new Date(r.date).toLocaleString()}</span>
                  <span className="text-destructive font-medium ml-2">-{formatCurrency(r.totalRefunded, r.currency)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1" />

          {/* Totals */}
          <div className="space-y-3 border-t border-destructive/20 pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal (USD)</span>
              <span className="font-medium">${subtotal.toFixed(2)}</span>
            </div>
            {refundCurrency === 'LBP' && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Rate</span>
                <span className="font-medium">1$ = {refundRate.toLocaleString()} L.L</span>
              </div>
            )}
            <div className="flex justify-between text-lg font-bold pt-2 border-t border-destructive/20">
              <span>Refund Total</span>
              <span className="text-destructive">{formatCurrency(total, refundCurrency)}</span>
            </div>
          </div>

          <button
            onClick={completeRefund}
            disabled={saving || cart.length === 0}
            className="w-full mt-6 h-14 text-base font-semibold bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <RotateCcw size={20} />
            Complete Refund
          </button>
        </div>
      </div>
    </div>
  );
}
