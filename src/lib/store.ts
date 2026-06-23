import { User, Product, Sale, InventoryEntry, Refund, Currency, RefundItem } from '@/types/pos';

const KEYS = {
  USERS: 'pos_users',
  PRODUCTS: 'pos_products',
  SALES: 'pos_sales',
  INVENTORY_ENTRIES: 'pos_inventory_entries',
  REFUNDS: 'pos_refunds',
  EXCHANGE_RATE: 'pos_exchange_rate',
  CURRENT_USER: 'pos_current_user',
};

function get<T>(key: string, fallback: T): T {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch {
    return fallback;
  }
}

// ONLY CHANGED THIS FUNCTION
function set<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to save ${key}:`, error);
    alert(`Storage error while saving ${key}. Storage may be full or corrupted.`);
    throw error;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// --- Seed defaults ---
export function initializeStore() {
  if (!localStorage.getItem(KEYS.USERS)) {
    const defaultUsers: User[] = [
      { id: '1', username: 'admin', password: 'admin123', role: 'admin', name: 'Administrator' },
      { id: '2', username: 'cashier', password: 'cashier123', role: 'cashier', name: 'Cashier 1' },
    ];
    set(KEYS.USERS, defaultUsers);
  }
  if (!localStorage.getItem(KEYS.PRODUCTS)) set(KEYS.PRODUCTS, []);
  if (!localStorage.getItem(KEYS.SALES)) set(KEYS.SALES, []);
  if (!localStorage.getItem(KEYS.INVENTORY_ENTRIES)) set(KEYS.INVENTORY_ENTRIES, []);
  if (!localStorage.getItem(KEYS.REFUNDS)) set(KEYS.REFUNDS, []);
  if (!localStorage.getItem(KEYS.EXCHANGE_RATE)) set(KEYS.EXCHANGE_RATE, 89500);
}

// --- Auth ---
export function login(username: string, password: string): User | null {
  const users = get<User[]>(KEYS.USERS, []);
  return users.find(u => u.username === username && u.password === password) || null;
}

export function getCurrentUser(): User | null {
  return get<User | null>(KEYS.CURRENT_USER, null);
}

export function setCurrentUser(user: User | null) {
  set(KEYS.CURRENT_USER, user);
}

export function getUsers(): User[] {
  return get<User[]>(KEYS.USERS, []);
}

export function addUser(user: Omit<User, 'id'>): User {
  const users = get<User[]>(KEYS.USERS, []);
  const newUser = { ...user, id: generateId() };
  users.push(newUser);
  set(KEYS.USERS, users);
  return newUser;
}

export function deleteUser(id: string): void {
  const users = get<User[]>(KEYS.USERS, []).filter(u => u.id !== id);
  set(KEYS.USERS, users);
}

// --- Products ---
export function getProducts(): Product[] {
  return get<Product[]>(KEYS.PRODUCTS, []);
}

export function getProductByBarcode(barcode: string): Product | undefined {
  return getProducts().find(p => p.barcode === barcode);
}

export function addProduct(product: Omit<Product, 'id'>): Product {
  const products = getProducts();
  const existing = products.find(p => p.barcode === product.barcode);
  if (existing) {
    existing.stockQuantity += product.stockQuantity;
    existing.purchasePrice = product.purchasePrice;
    existing.salePrice = product.salePrice;
    existing.name = product.name;
    set(KEYS.PRODUCTS, products);
    return existing;
  }
  const newProduct = { ...product, id: generateId() };
  products.push(newProduct);
  set(KEYS.PRODUCTS, products);
  return newProduct;
}

export function updateProduct(id: string, updates: Partial<Product>): void {
  const products = getProducts();
  const idx = products.findIndex(p => p.id === id);
  if (idx >= 0) {
    products[idx] = { ...products[idx], ...updates };
    set(KEYS.PRODUCTS, products);
  }
}

export function updateProductStock(productId: string, quantityChange: number): void {
  const products = getProducts();
  const product = products.find(p => p.id === productId);
  if (product) {
    product.stockQuantity += quantityChange;
    set(KEYS.PRODUCTS, products);
  }
}

// --- Sales ---
export function getSales(): Sale[] {
  return get<Sale[]>(KEYS.SALES, []);
}

// ONLY CHANGED THIS FUNCTION
export function addSale(sale: Omit<Sale, 'id'>): Sale {
  try {
    const sales = getSales();
    const newSale = { ...sale, id: generateId() };
    sales.push(newSale);

    set(KEYS.SALES, sales);

    // Deduct stock
    sale.items.forEach(item => {
      updateProductStock(item.productId, -item.quantity);
    });

    return newSale;
  } catch (error) {
    console.error('addSale failed:', error);
    alert('Sale failed: ' + error);
    throw error;
  }
}

// --- Refunds ---
export function getRefunds(): Refund[] {
  return get<Refund[]>(KEYS.REFUNDS, []);
}

export function addPartialRefund(saleId: string, refundItems: RefundItem[], cashierName: string): Refund {
  const refunds = getRefunds();
  const sales = getSales();
  const sale = sales.find(s => s.id === saleId);
  if (!sale) throw new Error('Sale not found');

  const totalRefunded = refundItems.reduce((sum, i) => sum + i.salePrice * i.quantity, 0);
  const newRefund: Refund = {
    id: generateId(),
    saleId,
    items: refundItems,
    totalRefunded: sale.currency === 'USD' ? totalRefunded : convertCurrency(totalRefunded, 'USD', 'LBP', sale.exchangeRate),
    currency: sale.currency,
    date: new Date().toISOString(),
    cashierName,
  };
  refunds.push(newRefund);
  set(KEYS.REFUNDS, refunds);

  // Restore stock
  refundItems.forEach(item => {
    updateProductStock(item.productId, item.quantity);
  });

  // Update sale items quantities & check if fully refunded
  sale.items = sale.items.map(si => {
    const ri = refundItems.find(r => r.productId === si.productId);
    if (ri) return { ...si, quantity: si.quantity - ri.quantity };
    return si;
  }).filter(si => si.quantity > 0);

  if (sale.items.length === 0) {
    sale.refunded = true;
  }

  // Recalculate sale total
  const newSubtotal = sale.items.reduce((sum, i) => sum + i.salePrice * i.quantity, 0);
  sale.subtotal = newSubtotal;
  sale.total = sale.currency === 'USD' ? newSubtotal : convertCurrency(newSubtotal, 'USD', 'LBP', sale.exchangeRate);
  set(KEYS.SALES, sales);

  return newRefund;
}

export function deleteProduct(id: string): void {
  const products = getProducts().filter(p => p.id !== id);
  set(KEYS.PRODUCTS, products);
}

export function getLowStockProducts(threshold: number = 5): Product[] {
  return getProducts().filter(p => p.stockQuantity <= threshold && p.stockQuantity > 0);
}

export function getOutOfStockProducts(): Product[] {
  return getProducts().filter(p => p.stockQuantity <= 0);
}

// --- Inventory Entries ---
export function getInventoryEntries(): InventoryEntry[] {
  return get<InventoryEntry[]>(KEYS.INVENTORY_ENTRIES, []);
}

export function addInventoryEntry(entry: Omit<InventoryEntry, 'id'>): InventoryEntry {
  const entries = getInventoryEntries();
  const newEntry = { ...entry, id: generateId() };
  entries.push(newEntry);
  set(KEYS.INVENTORY_ENTRIES, entries);

  // Add/update product
  addProduct({
    barcode: entry.barcode,
    name: entry.productName,
    stockQuantity: entry.quantityAdded,
    purchasePrice: entry.purchasePrice,
    salePrice: entry.salePrice,
  });

  return newEntry;
}

// --- Exchange Rate ---
export function getExchangeRate(): number {
  return get<number>(KEYS.EXCHANGE_RATE, 89500);
}

export function setExchangeRate(rate: number): void {
  set(KEYS.EXCHANGE_RATE, rate);
}

// --- Helpers ---
export function formatCurrency(amount: number, currency: Currency): string {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${amount.toLocaleString()} L.L`;
}

export function convertCurrency(amount: number, from: Currency, to: Currency, rate: number): number {
  if (from === to) return amount;
  if (from === 'USD' && to === 'LBP') return amount * rate;
  return amount / rate;
}

export function getTodayStr(): string {
  return new Date().toISOString().split('T')[0];
}
