import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { CartItem, Currency, SaleItem, Product } from '@/types/pos';
import { formatCurrency, convertCurrency } from '@/lib/store';
import {
  getProductsSql,
  addSaleSql,
  getExchangeRateSql,
} from '@/lib/sqlStore';
import { ShoppingCart, Trash2, Plus, Minus, ScanBarcode, Pause, Play } from 'lucide-react';

interface HeldOrder {
  id: string;
  name: string;
  cart: CartItem[];
  currency: Currency;
  heldAt: string;
}

export default function POSPage() {
  const { user, isAdmin } = useAuth();
  const [cart, setCart] = useState<CartItem[]>([]);
  const [barcode, setBarcode] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [products, setProducts] = useState<Product[]>([]);
  const [rate, setRate] = useState(89500);
  const [suggestions, setSuggestions] = useState<Product[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [heldOrders, setHeldOrders] = useState<HeldOrder[]>([]);
  const [showHoldInput, setShowHoldInput] = useState(false);
  const [holdName, setHoldName] = useState('');
  const [customPrices, setCustomPrices] = useState<Record<string, number>>({});

  const barcodeRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    barcodeRef.current?.focus();
  }, []);

  useEffect(() => {
    async function loadData() {
      const loadedProducts = await getProductsSql();
      const loadedRate = await getExchangeRateSql();

      setProducts(loadedProducts);
      setRate(loadedRate);
    }

    loadData().catch(error => {
      console.error('Failed to load POS data:', error);
      alert('Failed to load POS data: ' + error);
    });
  }, []);

  const heldStorageKey = user ? `pos_held_orders_${user.id}` : null;

  useEffect(() => {
    if (!heldStorageKey) return;
    try {
      const raw = localStorage.getItem(heldStorageKey);
      setHeldOrders(raw ? JSON.parse(raw) : []);
    } catch {
      setHeldOrders([]);
    }
  }, [heldStorageKey]);

  useEffect(() => {
    if (!heldStorageKey) return;
    try {
      localStorage.setItem(heldStorageKey, JSON.stringify(heldOrders));
    } catch {}
  }, [heldOrders, heldStorageKey]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        barcodeRef.current &&
        !barcodeRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const addToCart = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;

      let product = products.find(p => p.barcode === trimmed);

      if (!product) {
        product = products.find(
          p => p.name.toLowerCase() === trimmed.toLowerCase()
        );
      }

      if (!product) return;

      setCart(prev => {
        const existing = prev.find(c => c.product.id === product!.id);

        if (existing) {
          return prev.map(c =>
            c.product.id === product!.id
              ? { ...c, quantity: c.quantity + 1 }
              : c
          );
        }

        return [...prev, { product, quantity: 1 }];
      });

      setSuggestions([]);
      setShowSuggestions(false);
    },
    [products]
  );

  const handleInputChange = (value: string) => {
    setBarcode(value);

    if (value.trim().length >= 1) {
      const query = value.trim().toLowerCase();

      const matches = products.filter(
        p =>
          p.name.toLowerCase().startsWith(query) ||
          p.barcode.toLowerCase().startsWith(query)
      );

      setSuggestions(matches);
      setShowSuggestions(matches.length > 0);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const handleBarcodeScan = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && barcode.trim()) {
      e.preventDefault();

      addToCart(barcode);
      setBarcode('');
      setSuggestions([]);
      setShowSuggestions(false);
    }
  };

  const selectSuggestion = (product: Product) => {
    setCart(prev => {
      const existing = prev.find(c => c.product.id === product.id);

      if (existing) {
        return prev.map(c =>
          c.product.id === product.id
            ? { ...c, quantity: c.quantity + 1 }
            : c
        );
      }

      return [...prev, { product, quantity: 1 }];
    });

    setBarcode('');
    setSuggestions([]);
    setShowSuggestions(false);
    barcodeRef.current?.focus();
  };

  const updateQty = (productId: string, newQty: number) => {
    setCart(prev =>
      prev.map(c => {
        if (c.product.id !== productId) return c;
        if (newQty <= 0) return c;
        return { ...c, quantity: newQty };
      })
    );
  };

  const getEffectivePrice = (productId: string, originalPrice: number) => {
    return customPrices[productId] ?? originalPrice;
  };

  const removeItem = (productId: string) => {
    setCart(prev => prev.filter(c => c.product.id !== productId));
  };

  const subtotal = cart.reduce(
    (sum, c) =>
      sum + getEffectivePrice(c.product.id, c.product.salePrice) * c.quantity,
    0
  );

  const total =
    currency === 'USD'
      ? subtotal
      : convertCurrency(subtotal, 'USD', 'LBP', rate);

  const completeSale = async () => {
    if (cart.length === 0) return;

    try {
      const items: SaleItem[] = cart.map(c => ({
        productId: c.product.id,
        productName: c.product.name,
        barcode: c.product.barcode,
        quantity: c.quantity,
        salePrice: getEffectivePrice(c.product.id, c.product.salePrice),
        purchasePrice: c.product.purchasePrice,
        currency,
      }));

      await addSaleSql({
        items,
        subtotal,
        total,
        currency,
        exchangeRate: rate,
        cashierName: user?.name || '',
        date: new Date().toISOString(),
        refunded: false,
      });

      const updatedProducts = await getProductsSql();
      setProducts(updatedProducts);

      setCart([]);
      setCustomPrices({});
      barcodeRef.current?.focus();
    } catch (error) {
      console.error('Complete sale failed:', error);
      alert('Complete sale failed: ' + error);
    }
  };

  const holdOrder = () => {
    if (cart.length === 0) return;
    setHoldName('');
    setShowHoldInput(true);
  };

  const confirmHold = () => {
    if (cart.length === 0) {
      setShowHoldInput(false);
      return;
    }

    const trimmed = holdName.trim() || `Order ${heldOrders.length + 1}`;

    const held: HeldOrder = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: trimmed,
      cart: [...cart],
      currency,
      heldAt: new Date().toLocaleTimeString(),
    };

    setHeldOrders(prev => [...prev, held]);
    setCart([]);
    setShowHoldInput(false);
    setHoldName('');
    barcodeRef.current?.focus();
  };

  const cancelHold = () => {
    setShowHoldInput(false);
    setHoldName('');
  };

  const resumeOrder = (id: string) => {
    const order = heldOrders.find(o => o.id === id);
    if (!order) return;

    setCart(order.cart);
    setCurrency(order.currency);
    setHeldOrders(prev => prev.filter(o => o.id !== id));
    barcodeRef.current?.focus();
  };

  return (
    <div className="flex h-full">
      <div className="flex-1 p-6 flex flex-col">
        <div className="flex items-center gap-3 mb-6">
          <ScanBarcode className="text-primary" size={24} />
          <h2 className="pos-header">Point of Sale</h2>
        </div>

        <div className="mb-6 relative">
          <div className="flex gap-3">
            <input
              ref={barcodeRef}
              data-barcode-input="true"
              className="pos-input flex-1"
              placeholder="Scan barcode or type product name..."
              value={barcode}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={handleBarcodeScan}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true);
              }}
            />

            <button
              className="pos-btn-primary"
              onClick={() => {
                addToCart(barcode);
                setBarcode('');
              }}
            >
              Add
            </button>
          </div>

          <p className="text-xs text-muted-foreground mt-1.5">
            USB/Bluetooth barcode scanner auto-detected
          </p>

          {showSuggestions && suggestions.length > 0 && (
            <div
              ref={suggestionsRef}
              className="absolute left-0 right-16 top-[44px] z-50 bg-card border border-border rounded-md shadow-lg max-h-48 overflow-auto"
            >
              {suggestions.map(p => (
                <button
                  key={p.id}
                  onClick={() => selectSuggestion(p)}
                  className="w-full text-left px-3 py-2 hover:bg-muted transition-colors flex justify-between items-center text-sm"
                >
                  <span className="font-medium text-foreground">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.barcode}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {heldOrders.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {heldOrders.map(order => (
              <button
                key={order.id}
                onClick={() => resumeOrder(order.id)}
                className="flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-colors shadow-sm"
              >
                <Play size={12} />
                <span>
                  {order.name} — {order.cart.length} items — {order.heldAt}
                </span>
              </button>
            ))}
          </div>
        )}

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
                        <button
                          onClick={() => updateQty(c.product.id, c.quantity - 1)}
                          className="p-1 rounded hover:bg-muted"
                        >
                          <Minus size={14} />
                        </button>

                        <input
                          type="number"
                          min="1"
                          value={c.quantity}
                          onChange={e =>
                            updateQty(c.product.id, Math.max(1, +e.target.value))
                          }
                          className="w-12 text-center font-medium bg-transparent border border-border rounded px-1 py-0.5 text-sm"
                        />

                        <button
                          onClick={() => updateQty(c.product.id, c.quantity + 1)}
                          className="p-1 rounded hover:bg-muted"
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                    </td>

                    <td className="py-3 px-3 text-right text-muted-foreground">
                      {isAdmin ? (
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={customPrices[c.product.id] ?? c.product.salePrice}
                          onChange={e =>
                            setCustomPrices(prev => ({
                              ...prev,
                              [c.product.id]: Math.max(0, +e.target.value),
                            }))
                          }
                          className="w-20 text-right font-medium bg-transparent border border-border rounded px-1 py-0.5 text-sm"
                        />
                      ) : (
                        <span>${c.product.salePrice.toFixed(2)}</span>
                      )}
                    </td>

                    <td className="py-3 px-3 text-right font-medium">
                      $
                      {(
                        getEffectivePrice(c.product.id, c.product.salePrice) *
                        c.quantity
                      ).toFixed(2)}
                    </td>

                    <td className="py-3 px-3">
                      <button
                        onClick={() => removeItem(c.product.id)}
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

      <div className="w-80 border-l border-border bg-card p-6 flex flex-col">
        <h3 className="pos-header mb-6">Order Summary</h3>

        <div className="flex rounded-lg border border-border overflow-hidden mb-6">
          {(['USD', 'LBP'] as Currency[]).map(c => (
            <button
              key={c}
              onClick={() => setCurrency(c)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                currency === c
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card text-muted-foreground hover:bg-muted'
              }`}
            >
              {c === 'USD' ? '$ USD' : 'L.L LBP'}
            </button>
          ))}
        </div>

        <div className="flex-1" />

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
              <span className="font-medium">
                1$ = {rate.toLocaleString()} L.L
              </span>
            </div>
          )}

          <div className="flex justify-between text-lg font-bold pt-2 border-t border-border">
            <span>Total</span>
            <span className="text-primary">{formatCurrency(total, currency)}</span>
          </div>
        </div>

        {showHoldInput ? (
          <div className="mt-4 flex flex-col gap-2">
            <input
              autoFocus
              type="text"
              value={holdName}
              onChange={e => setHoldName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmHold();
                else if (e.key === 'Escape') cancelHold();
              }}
              placeholder="Receipt name"
              className="pos-input w-full"
            />

            <div className="flex gap-2">
              <button onClick={confirmHold} className="pos-btn-primary flex-1">
                Save
              </button>

              <button
                onClick={cancelHold}
                className="flex-1 rounded-md border border-border text-sm py-2 hover:bg-muted"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={holdOrder}
            disabled={cart.length === 0}
            className="pos-btn-primary w-full mt-4 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Pause size={16} />
            On Hold
          </button>
        )}

        <button
          onClick={completeSale}
          disabled={cart.length === 0}
          className="pos-btn-success w-full mt-3 h-14 text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Complete Sale — Cash
        </button>
      </div>
    </div>
  );
}
