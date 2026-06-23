import { useState, useRef, useEffect, useCallback } from 'react';
import { formatCurrency, convertCurrency } from '@/lib/store';
import {
  getSalesSql,
  getRefundsSql,
  getProductByBarcodeSql,
  getExchangeRateSql,
  addPartialRefundSql,
} from '@/lib/sqlStore';
import { useAuth } from '@/contexts/AuthContext';
import { AlertTriangle, RotateCcw, ScanBarcode, Trash2, Plus, Minus } from 'lucide-react';
import { toast } from 'sonner';
import { Product, Currency, Sale, Refund } from '@/types/pos';
import { useBarcodeScanner } from '@/hooks/useBarcodeScanner';

interface RefundCartItem {
  product: Product;
  quantity: number;
  saleId: string;
  maxQuantity: number;
  salePrice: number;
  purchasePrice: number;
}

export default function RefundsPage() {
  const { user } = useAuth();
  const [cart, setCart] = useState<RefundCartItem[]>([]);
  const [barcode, setBarcode] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [rate, setRate] = useState(89500);
  const [sales, setSales] = useState<Sale[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const barcodeRef = useRef<HTMLInputElement>(null);

  const loadData = async () => {
    setSales(await getSalesSql());
    setRefunds(await getRefundsSql());
    setRate(await getExchangeRateSql());
  };

  useEffect(() => {
    barcodeRef.current?.focus();

    loadData().catch(error => {
      console.error('Failed to load refund data:', error);
      alert('Failed to load refund data: ' + error);
    });
  }, []);

  const addToRefundCart = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;

      const product = await getProductByBarcodeSql(trimmed);

      if (!product) {
        toast.error('Product not found');
        return;
      }

      const eligibleSale = sales
        .filter(s => !s.refunded)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .find(sale => {
          const saleItem = sale.items.find(i => i.barcode === trimmed);
          if (!saleItem) return false;

          const inCart = cart.find(
            c => c.saleId === sale.id && c.product.id === product.id
          );

          const cartQty = inCart ? inCart.quantity : 0;
          return saleItem.quantity - cartQty > 0;
        });

      if (!eligibleSale) {
        toast.error('No sale found with this product to refund');
        return;
      }

      const saleItem = eligibleSale.items.find(i => i.barcode === trimmed)!;

      setCart(prev => {
        const existing = prev.find(
          c => c.saleId === eligibleSale.id && c.product.id === product.id
        );

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

        return [
          ...prev,
          {
            product,
            quantity: 1,
            saleId: eligibleSale.id,
            maxQuantity: saleItem.quantity,
            salePrice: saleItem.salePrice,
            purchasePrice: saleItem.purchasePrice,
          },
        ];
      });

      toast.success(`Refund: ${product.name}`);
    },
    [cart, sales]
  );

  useBarcodeScanner(addToRefundCart);

  const handleBarcodeScan = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && barcode.trim()) {
      addToRefundCart(barcode);
      setBarcode('');
    }
  };

  const updateQty = (productId: string, saleId: string, newQty: number) => {
    setCart(prev =>
      prev.map(c => {
        if (c.product.id !== productId || c.saleId !== saleId) return c;
        if (newQty <= 0) return c;

        if (newQty > c.maxQuantity) {
          toast.error('Cannot exceed sold quantity');
          return c;
        }

        return { ...c, quantity: newQty };
      })
    );
  };

  const removeItem = (productId: string, saleId: string) => {
    setCart(prev =>
      prev.filter(c => !(c.product.id === productId && c.saleId === saleId))
    );
  };

  const subtotal = cart.reduce((sum, c) => sum + c.salePrice * c.quantity, 0);
  const total = currency === 'USD' ? subtotal : convertCurrency(subtotal, 'USD', 'LBP', rate);

  const completeRefund = async () => {
    if (cart.length === 0) {
      toast.error('Refund cart is empty');
      return;
    }

    if (!confirm(`Process refund of ${formatCurrency(total, currency)}? This will restore stock.`)) return;

    try {
      const bySale = cart.reduce<Record<string, RefundCartItem[]>>((acc, item) => {
        if (!acc[item.saleId]) acc[item.saleId] = [];
        acc[item.saleId].push(item);
        return acc;
      }, {});

      for (const [saleId, items] of Object.entries(bySale)) {
        await addPartialRefundSql(
          saleId,
          items.map(i => ({
            productId: i.product.id,
            productName: i.product.name,
            barcode: i.product.barcode,
            quantity: i.quantity,
            salePrice: i.salePrice,
            purchasePrice: i.purchasePrice,
            currency,
          })),
          user?.name || ''
        );
      }

      await loadData();

      toast.success('Refund processed successfully');
      setCart([]);
      barcodeRef.current?.focus();
    } catch (error) {
      console.error('Refund failed:', error);
      alert('Refund failed: ' + error);
    }
  };

  return (
    <div className="flex h-full flex-col" style={{ backgroundColor: 'hsl(0, 40%, 97%)' }}>
      <div className="sticky top-0 z-50 bg-destructive text-destructive-foreground px-6 py-4 flex items-center gap-3 shadow-lg">
        <AlertTriangle size={28} className="animate-pulse" />
        <span className="text-xl font-bold tracking-wide">⚠️ REFUND MODE ACTIVE</span>
        <AlertTriangle size={28} className="animate-pulse" />
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 p-6 flex flex-col">
          <div className="flex items-center gap-3 mb-6">
            <ScanBarcode className="text-destructive" size={24} />
            <h2 className="text-xl font-bold text-destructive">Scan Items to Refund</h2>
          </div>

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
                onClick={() => {
                  addToRefundCart(barcode);
                  setBarcode('');
                }}
              >
                Add
              </button>
            </div>

            <p className="text-xs text-muted-foreground mt-1.5">
              Scan product barcode to add to refund cart
            </p>
          </div>

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
                          <button
                            onClick={() => updateQty(c.product.id, c.saleId, c.quantity - 1)}
                            className="p-1 rounded hover:bg-destructive/10"
                          >
                            <Minus size={14} />
                          </button>

                          <input
                            type="number"
                            min="1"
                            max={c.maxQuantity}
                            value={c.quantity}
                            onChange={e =>
                              updateQty(
                                c.product.id,
                                c.saleId,
                                Math.max(1, +e.target.value)
                              )
                            }
                            className="w-12 text-center font-medium bg-transparent border border-destructive/20 rounded px-1 py-0.5 text-sm"
                          />

                          <button
                            onClick={() => updateQty(c.product.id, c.saleId, c.quantity + 1)}
                            className="p-1 rounded hover:bg-destructive/10"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      </td>

                      <td className="py-3 px-3 text-right text-muted-foreground">
                        ${(Number(c.salePrice) || 0).toFixed(2)}
                      </td>

                      <td className="py-3 px-3 text-right font-medium">
                        ${((Number(c.salePrice) || 0) * (Number(c.quantity) || 0)).toFixed(2)}
                      </td>

                      <td className="py-3 px-3">
                        <button
                          onClick={() => removeItem(c.product.id, c.saleId)}
                          className="p-1 text-destructive hover:bg-destructive/10 rounded"
                        >
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

        <div className="w-80 border-l border-destructive/20 bg-white p-6 flex flex-col">
          <h3 className="text-lg font-bold text-destructive mb-6">Refund Summary</h3>

          <div className="flex rounded-lg border border-destructive/20 overflow-hidden mb-6">
            {(['USD', 'LBP'] as Currency[]).map(c => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  currency === c
                    ? 'bg-destructive text-destructive-foreground'
                    : 'bg-white text-muted-foreground hover:bg-destructive/5'
                }`}
              >
                {c === 'USD' ? '$ USD' : 'L.L LBP'}
              </button>
            ))}
          </div>

          <div className="mb-4">
            <p className="text-xs font-semibold text-destructive mb-2">
              Recent Refunds ({refunds.length})
            </p>

            <div className="space-y-1 max-h-24 overflow-auto">
              {[...refunds]
                .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                .slice(0, 3)
                .map(r => (
                  <div key={r.id} className="text-xs text-muted-foreground py-1">
                    <span>{new Date(r.date).toLocaleString()}</span>
                    <span className="text-destructive font-medium ml-2">
                      -{formatCurrency(r.totalRefunded, r.currency)}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          <div className="flex-1" />

          <div className="space-y-3 border-t border-destructive/20 pt-4">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal (USD)</span>
              <span className="font-medium">${(Number(subtotal) || 0).toFixed(2)}</span>
            </div>

            {currency === 'LBP' && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Rate</span>
                <span className="font-medium">1$ = {rate.toLocaleString()} L.L</span>
              </div>
            )}

            <div className="flex justify-between text-lg font-bold pt-2 border-t border-destructive/20">
              <span>Refund Total</span>
              <span className="text-destructive">{formatCurrency(total, currency)}</span>
            </div>
          </div>

          <button
            onClick={completeRefund}
            disabled={cart.length === 0}
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