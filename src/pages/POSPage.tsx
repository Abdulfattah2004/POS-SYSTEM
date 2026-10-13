import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { CartItem, Currency, SaleItem } from '@/types/pos';
import { getProductByBarcode, getProducts, addSale, getExchangeRate, getAllowNegativeStock, formatCurrency, convertCurrency, createTransactionId } from '@/lib/store';
import {getSavedAssociation,scopeKey} from '@/lib/localDatabase';
import {readPendingRequest,executePendingRequest,isUncertainCommit} from '@/lib/pendingRequest';
import { ShoppingCart, Trash2, Plus, Minus, ScanBarcode } from 'lucide-react';
import { useActionFeedback } from '@/hooks/useActionFeedback';
import CloudConnectionFeedback from '@/components/CloudConnectionFeedback';
import BranchConnectionStatus from '@/components/BranchConnectionStatus';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';
import {holdSale,getHeldSales,resumeHeldSale,cancelHeldSale} from '@/lib/heldSales';
import {settlementPreview} from '@/lib/settlement';

export default function POSPage() {
  const { toast, feedback } = useActionFeedback();
  const checkoutFeedback = useActionFeedback();
  const { user } = useAuth();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [barcode, setBarcode] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const barcodeRef = useRef<HTMLInputElement>(null);
  const rate = getExchangeRate();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const transaction = useRef<{ id: string; payload: Parameters<typeof addSale>[0]; heldSaleId?:string } | null>(null);
  const [activeHeldId,setActiveHeldId]=useState<string|undefined>();
  const [holdLabel,setHoldLabel]=useState('');
  const [,refreshHolds]=useState(0);
  const holds=getHeldSales();
  const pendingKey=`pos_checkout_v3:${user?.id}:${scopeKey(getSavedAssociation())}`;
  const [pendingRecovery,setPendingRecovery]=useState(false);
  const [startupError,setStartupError]=useState('');

  useEffect(() => {
    barcodeRef.current?.focus();
    try { transaction.current=readPendingRequest(pendingKey); setPendingRecovery(Boolean(transaction.current)); }
    catch(error){setStartupError(String(error));}
  }, [pendingKey]);

  const addToCart = useCallback((code: string) => {
    if (busy.current || transaction.current) return;
    const product = getProductByBarcode(code.trim()) ?? getProducts().find(p=>p.name.toLowerCase()===code.trim().toLowerCase());
    if (!product) {
      toast.error('Product not found');
      return;
    }
    if (!getAllowNegativeStock() && product.stockQuantity <= 0) {
      toast.error('Out of stock');
      return;
    }
    setCart(prev => {
      const existing = prev.find(c => c.product.barcode === product.barcode);
      if (existing) {
        if (!getAllowNegativeStock() && existing.quantity >= product.stockQuantity) {
          toast.error('Not enough stock');
          return prev;
        }
        return prev.map(c => c.product.barcode === product.barcode ? { ...c, quantity: c.quantity + 1 } : c);
      }
      return [...prev, { product, quantity: 1 }];
    });
    toast.success(`Added: ${product.name}`);
  }, [toast]);

  // Auto-detect barcode scanner input
  useBarcodeScanner(addToCart);

  const handleBarcodeScan = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && barcode.trim()) {
      e.preventDefault();
      addToCart(barcode);
      setBarcode('');
    }
  };

  const updateQty = (productId: string, newQty: number) => {
    if (busy.current || transaction.current) return;
    if (!Number.isSafeInteger(newQty) || newQty < 1 || newQty > 2147483647) {
      toast.error('Quantity must be a positive whole number within the supported range.');
      return;
    }
    setCart(prev => prev.map(c => {
      if (c.product.id !== productId) return c;
      if (newQty <= 0) return c;
      if (!getAllowNegativeStock() && newQty > c.product.stockQuantity) {
        toast.error('Not enough stock');
        return c;
      }
      return { ...c, quantity: newQty };
    }));
  };

  const removeItem = (productId: string) => {
    if (busy.current || transaction.current) return;
    setCart(prev => prev.filter(c => c.product.id !== productId));
  };

  const {subtotal,total} = settlementPreview(cart.map(c=>({quantity:c.quantity,salePrice:c.product.salePrice})),currency,rate);

  const holdCurrentCart=async()=>{
    if(busy.current||transaction.current||!cart.length)return;
    busy.current=true;setSaving(true);
    try {
      await holdSale({label:holdLabel,currency,items:cart.map(item=>({productId:item.product.id,quantity:item.quantity}))},createTransactionId(),activeHeldId);
      setCart([]);setActiveHeldId(undefined);setHoldLabel('');refreshHolds(value=>value+1);
      toast.info('Cart held on this device. Stock and revenue are unchanged.');
    }catch(error){toast.error(String(error));}finally{busy.current=false;setSaving(false);}
  };
  const resumeCart=(id:string)=>{
    if(busy.current||transaction.current)return;
    if(cart.length){toast.error('Hold or clear the current cart before resuming another.');return;}
    try {const held=resumeHeldSale(id);setCart(held.cart);setCurrency(held.currency);setActiveHeldId(id);setHoldLabel(holds.find(hold=>hold.id===id)?.label??'');toast.info(held.pricesChanged?'Held cart resumed with current prices and stock. Review the updated total.':'Held cart resumed. Current stock was checked; checkout checks again.');}
    catch(error){toast.error(String(error));}
  };
  const cancelCart=async(id:string)=>{
    if(busy.current||transaction.current)return;
    busy.current=true;setSaving(true);
    try {await cancelHeldSale(id);if(activeHeldId===id){setCart([]);setActiveHeldId(undefined);setHoldLabel('');}refreshHolds(value=>value+1);toast.info('Held cart cancelled. Stock and revenue are unchanged.');}
    catch(error){toast.error(String(error));}finally{busy.current=false;setSaving(false);}
  };

  const completeSale = async () => {
    const toast = checkoutFeedback.toast;
    if (busy.current) return;
    if (cart.length === 0 && !transaction.current) {
      toast.error('Cart is empty');
      return;
    }

    const items: SaleItem[] = cart.map(c => ({
      productId: c.product.id,
      productName: c.product.name,
      barcode: c.product.barcode,
      quantity: c.quantity,
      salePrice: c.product.salePrice,
      purchasePrice: c.product.purchasePrice,
      currency,
    }));

    busy.current = true; setSaving(true);
    try {
    transaction.current ??= { id: createTransactionId(), heldSaleId: activeHeldId, payload: {
      items,
      subtotal,
      total,
      currency,
      exchangeRate: rate,
      cashierName: user?.name || '',
      date: new Date().toISOString(),
      refunded: false,
    } };
    await executePendingRequest(pendingKey,transaction.current,request=>addSale(request.payload,request.id,request.heldSaleId));
    transaction.current = null;
    setPendingRecovery(false);

    toast.success('Sale saved on this device. Cloud confirmation is tracked in Settings.');
    setCart([]);
    setActiveHeldId(undefined);setHoldLabel('');refreshHolds(value=>value+1);
    barcodeRef.current?.focus();
    } catch (error) {
      if(!isUncertainCommit(error)){transaction.current=null;setPendingRecovery(false);}
      else setPendingRecovery(true);
      toast.error(error instanceof Error ? error.message : String(error));
    }
    finally { busy.current = false; setSaving(false); }
  };

  return (
    startupError ? <div role="alert" className="p-6">{startupError}</div> :
    <div className="flex min-h-full flex-col lg:flex-row">
      {/* Left: Scanner + Products */}
      <div className="flex-1 min-w-0 p-6 flex flex-col">
        {pendingRecovery&&transaction.current&&<div role="alert" className="pos-card p-4 mb-4"><p>A previous checkout needs confirmation.</p><p>Saved transaction: {transaction.current.id} · {transaction.current.payload.items.reduce((count,item)=>count+item.quantity,0)} items · {formatCurrency(settlementPreview(transaction.current.payload.items,transaction.current.payload.currency,transaction.current.payload.exchangeRate).total,transaction.current.payload.currency)}</p><button className="pos-btn-primary" disabled={saving} onClick={completeSale}>Retry saved checkout</button></div>}
        <div className="flex items-center gap-3 mb-6">
          <ScanBarcode className="text-primary" size={24} />
          <h2 className="pos-header">Point of Sale</h2>
        </div>

        {/* Barcode Input */}
        <div className="mb-6">
          <div className="flex gap-3">
            <input
              disabled={saving}
              ref={barcodeRef}
              data-barcode-input="true"
              className="pos-input flex-1"
              placeholder="Scan barcode or type product code..."
              value={barcode}
              onChange={e => setBarcode(e.target.value)}
              onKeyDown={handleBarcodeScan}
            />
            <button disabled={saving||pendingRecovery} className="pos-btn-primary" onClick={() => { addToCart(barcode); setBarcode(''); }}>
              Add
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">USB/Bluetooth barcode scanner auto-detected</p>
          {feedback}
        </div>

        {/* Cart Items */}
        {holds.length>0&&<section aria-label="Held sales" className="pos-card p-4 mb-4 max-h-48 overflow-auto">
          <h3 className="font-semibold mb-2">On Hold ({holds.length})</h3>
          {holds.map(hold=><div key={hold.id} className="flex items-center gap-3 py-2 border-t border-border">
            <div className="flex-1 text-sm"><p className="font-medium">{hold.label||'Held cart'}{activeHeldId===hold.id?' — Resumed':''}</p><p className="text-xs text-muted-foreground">{hold.cashierName} · {hold.items.reduce((count,item)=>count+item.quantity,0)} items · {new Date(hold.createdAt).toLocaleString()}</p></div>
            <button type="button" disabled={saving||pendingRecovery} onClick={()=>resumeCart(hold.id)} className="pos-btn-primary">Resume</button>
            <button type="button" disabled={saving||pendingRecovery} onClick={()=>cancelCart(hold.id)} className="text-destructive text-sm">Cancel held sale</button>
          </div>)}
        </section>}
        <div className="flex-1 overflow-auto">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
              <ShoppingCart size={48} className="mb-3 opacity-30" />
              <p className="text-sm">Cart is empty</p>
              <p className="text-xs mt-1">Scan items to get started</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="pos-table-header">
                  <th className="text-left py-2.5 px-3">Item</th>
                  <th className="text-center py-2.5 px-3">Qty</th>
                  <th className="text-right py-2.5 px-3">Price</th>
                  <th className="text-right py-2.5 px-3">Total</th>
                  <th className="py-2.5 px-3 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {cart.map(c => (
                  <tr key={c.product.id} className="border-b border-border">
                    <td className="py-3 px-3">
                      <p className="font-medium text-foreground">{c.product.name}</p>
                      <p className="text-xs text-muted-foreground">{c.product.barcode}</p>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-center gap-1.5">
                        <button aria-label={`Decrease ${c.product.name}`} onClick={() => updateQty(c.product.id, c.quantity - 1)} className="p-1 rounded hover:bg-muted">
                          <Minus size={14} />
                        </button>
                        <input
                          type="number"
                          min="1"
                          max={getAllowNegativeStock() ? undefined : c.product.stockQuantity}
                          value={c.quantity}
                          onChange={e => updateQty(c.product.id, Math.max(1, +e.target.value))}
                          aria-label={`Quantity for ${c.product.name}`} step="1"
                          className="w-16 text-center font-medium bg-transparent border border-border rounded px-1 py-0.5 text-sm"
                        />
                        <button aria-label={`Increase ${c.product.name}`} onClick={() => updateQty(c.product.id, c.quantity + 1)} className="p-1 rounded hover:bg-muted">
                          <Plus size={14} />
                        </button>
                      </div>
                    </td>
                    <td className="py-3 px-3 text-right text-muted-foreground">${c.product.salePrice.toFixed(2)}</td>
                    <td className="py-3 px-3 text-right font-medium">${(c.product.salePrice * c.quantity).toFixed(2)}</td>
                    <td className="py-3 px-3">
                      <button aria-label={`Remove ${c.product.name}`} onClick={() => removeItem(c.product.id)} className="p-1 text-destructive hover:bg-destructive/10 rounded">
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
      <div className="w-full lg:w-80 lg:shrink-0 border-t lg:border-t-0 lg:border-l border-border bg-card p-6 flex flex-col">
        <h3 className="pos-header mb-6">Order Summary</h3>

        {/* Currency Toggle */}
        <div className="flex rounded-lg border border-border overflow-hidden mb-6">
          {(['USD', 'LBP'] as Currency[]).map(c => (
            <button
              key={c}
              disabled={saving||pendingRecovery}
              onClick={() => setCurrency(c)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                currency === c ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted'
              }`}
            >
              {c === 'USD' ? '$ USD' : 'L.L LBP'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <label className="text-sm mb-2">Hold note<input className="pos-input mt-1 w-full" maxLength={200} placeholder="Customer or hold note" value={holdLabel} disabled={saving||pendingRecovery} onChange={event=>setHoldLabel(event.target.value)} /></label>
        <button type="button" className="pos-btn-primary mb-3" disabled={saving||pendingRecovery||!cart.length} onClick={holdCurrentCart}>Hold Sale</button>
        {cart.length>0&&<button type="button" className="text-sm underline mb-3" disabled={saving||pendingRecovery} onClick={()=>{setCart([]);setActiveHeldId(undefined);setHoldLabel('');}}>Clear current cart</button>}

        {/* Totals */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Subtotal (USD)</span>
            <span className="font-medium">${subtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Tax</span>
            <span className="font-medium">0%</span>
          </div>
          {currency === 'LBP' && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Rate</span>
              <span className="font-medium">1$ = {rate.toLocaleString()} L.L</span>
            </div>
          )}
          <div className="flex justify-between text-lg font-bold pt-2 border-t border-border">
            <span>Total</span>
            <span className="text-primary">{formatCurrency(total, currency)}</span>
          </div>
        </div>

        <button
          onClick={completeSale}
          disabled={saving || cart.length === 0}
          className="pos-btn-success w-full mt-6 h-14 text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Complete Sale — Cash
        </button>
        {checkoutFeedback.feedback}
        <CloudConnectionFeedback />
        <BranchConnectionStatus />
      </div>
    </div>
  );
}
