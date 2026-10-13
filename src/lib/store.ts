import { businessDate } from './accounting';
import { User, Product, Sale, InventoryEntry, Refund, Currency, RefundItem } from '@/types/pos';
import { appendInventoryOperation, initializeInventorySync, syncPendingInventory } from '@/lib/inventorySync';
import { activeBranch, readVisibleCollection, readBranchPreferences, originalRecoveryPending, scopeKey, stableJson, resolveLocalProductId, getLocalState, initializeLocalDatabase, localTransaction, type BranchData, type LocalState } from './localDatabase';

import { initializeLocalAuth, requireOperator } from './localAuth';
export { login, logout, getCurrentUser, getUsers, addUser, deleteUser, needsAdministratorSetup } from './localAuth';
export async function initializeStore() {
  await initializeLocalDatabase();
  await initializeLocalAuth();
  initializeInventorySync();
}

// Every financial/inventory mutation and its outbox commit in one transaction.
export const createTransactionId = (): string => crypto.randomUUID();
export const money = (value: number) => { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER / 100) throw new Error('Amount exceeds supported precision.'); return Math.round((value + Number.EPSILON) * 100) / 100; };
function quantity(value: number, allowZero = false) {
  if (!Number.isSafeInteger(value) || value > 2147483647 || value < (allowZero ? 0 : 1)) throw new Error('Quantity must be a valid whole number.');
}
function price(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 100) throw new Error('Price must be finite and nonnegative.');
}
function stock(value: number) {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Stock must be a signed whole number within the supported range.');
}
function validProduct(product: Product) {
  stock(product.stockQuantity); price(product.purchasePrice); price(product.salePrice);
  if (!product.name.trim() || !product.barcode.trim()) throw new Error('Product name and barcode are required.');
}
function retry<T>(branch: BranchData, id: string, request: unknown, apply: () => T): T {
  if (!id || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Invalid transaction ID.');
  const fingerprint = stableJson(request);
  const previous = branch.completed[id];
  if (previous) {
    if (previous.request !== fingerprint) throw new Error('Transaction ID was already used with different data.');
    return previous.result as T;
  }
  const result = apply();
  branch.completed[id] = { request: fingerprint, result };
  return result;
}
async function commit<T>(apply: (state: LocalState, branch: BranchData) => T, admin = false): Promise<T> {
  const expectedScope = scopeKey(getLocalState().association);
  const result = await localTransaction(state => {
    if (scopeKey(state.association) !== expectedScope) throw new Error('Branch changed. Reload before making changes.');
    requireOperator(state, admin);
    if (originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending) {
      throw new Error('Connection is saved separately. Checkout, inventory changes and refunds are paused until current inventory ownership is verified for this branch. Historical sales do not require reassignment. Original records remain unchanged.');
    }
    if (state.outbox.some(operation => !state.inventoryActivation?.historicalOperationIds.includes(operation.operationId) && operation.blocked && operation.businessId === state.association?.businessId && operation.branchId === state.association?.branchId)) throw new Error('This branch has an unresolved cloud conflict. An administrator must reconcile it before new transactions.');
    return apply(state, activeBranch(state));
  });
  void syncPendingInventory().catch(console.error);
  return result;
}
export function getProducts(): Product[] { return readVisibleCollection('products').filter(product => product.isActive !== false); }
export function getProductByBarcode(barcode: string): Product | undefined {
  return getProducts().find(product => product.barcode === barcode.trim());
}
export function getRefundableItemsByBarcode(barcode: string) {
  const code = barcode.trim();
  if (!code) return [];
  const branch = activeBranch();
  const matches = branch.sales.filter(sale => !sale.legacy)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .flatMap(sale => sale.items.flatMap(item => {
      const product = branch.products.find(product => product.id === resolveLocalProductId(branch, item.productId));
      const remaining = remainingQuantity(sale, item.productId, branch.refunds);
      return product && remaining > 0 && (item.barcode === code || product.barcode === code)
        ? [{ sale, item, product, remaining }] : [];
    }));
  if (new Set(matches.map(match => match.product.id)).size > 1) throw new Error('Barcode matches different historical products. Select the original receipt to refund.');
  return matches;
}
export async function addProduct(input: Omit<Product, 'id'>, id = createTransactionId()): Promise<Product> {
  return commit((state, branch) => retry(branch, id, input, () => {
    const existing = branch.products.find(product => product.barcode === input.barcode.trim());
    const product = { ...input, name: input.name.trim(), barcode: input.barcode.trim(), id: existing?.id ?? id };
    validProduct(product);
    if (input.isActive === false || existing?.isActive === false) throw new Error('Use an inventory receipt to reactivate an archived product.');
    if (existing) {
      stock(existing.stockQuantity + input.stockQuantity);
      existing.stockQuantity += input.stockQuantity;
      existing.purchasePrice = input.purchasePrice; existing.salePrice = input.salePrice; existing.name = input.name.trim();
      appendInventoryOperation(state, { type: 'product_adjust', productId: existing.id, quantityDelta: input.stockQuantity, updates: { name: input.name.trim(), purchasePrice: input.purchasePrice, salePrice: input.salePrice } }, id + ':adjust');
      return { ...existing };
    }
    branch.products.push(product);
    appendInventoryOperation(state, { type: 'product_upsert', product }, id);
    return product;
  }), true);
}
export async function updateProduct(id: string, updates: Partial<Product>, transactionId = createTransactionId()): Promise<string[]> {
  return commit((state, branch) => retry(branch, transactionId, { id, updates }, () => {
    const product = branch.products.find(product => product.id === id);
    if (!product) throw new Error('Product not found.');
    if (updates.isActive !== undefined) throw new Error('Product activity must be changed through reviewed archive or receipt operations.');
    if (updates.id && updates.id !== id) throw new Error('Product identity cannot be edited.');
    const normalized = { ...updates, ...(updates.barcode !== undefined ? { barcode: updates.barcode.trim() } : {}), ...(updates.name !== undefined ? { name: updates.name.trim() } : {}) };
    const updated = { ...product, ...normalized };
    validProduct(updated);
    if (branch.products.some(other => other.id !== id && other.barcode === updated.barcode)) throw new Error('Barcode is already in use.');
    const delta = updated.stockQuantity - product.stockQuantity;
    Object.assign(product, updated);
    const ids: string[] = [];

    const { stockQuantity: _stock, id: _id, ...metadata } = normalized;
    if (delta || Object.keys(metadata).length) ids.push(appendInventoryOperation(state, { type: 'product_adjust', productId: id, quantityDelta: delta, updates: metadata }, transactionId + ':adjust'));
    return ids;
  }), true);
}
export async function updateProductStock(productId: string, quantityChange: number, operationId = createTransactionId()): Promise<string> {
  return commit((state, branch) => retry(branch, operationId, { productId, quantityChange }, () => {
    if (!Number.isSafeInteger(quantityChange) || !quantityChange) throw new Error('Stock adjustment must be a nonzero whole number.');
    const product = branch.products.find(product => product.id === productId);
    if (!product) throw new Error('Product not found.');
    stock(product.stockQuantity + quantityChange);
    product.stockQuantity += quantityChange;
    return appendInventoryOperation(state, { type: 'stock_delta', productId, quantityDelta: quantityChange }, operationId);
  }), true);
}
export function getSales(): Sale[] { return readVisibleCollection('sales'); }
export async function addSale(input: Omit<Sale, 'id'>, id = createTransactionId(), heldSaleId?:string): Promise<Sale> {
  return commit((state, branch) => retry(branch, id, heldSaleId?{input,heldSaleId}:input, () => {
    if(heldSaleId) {
      const held=branch.heldSales?.find(hold=>hold.id===heldSaleId),user=requireOperator(state);
      if(!held||(held.userId!==user.id&&user.role!=='admin'))throw new Error('Held sale was already checked out or cancelled. Reload before checkout.');
    }
    if (!['USD', 'LBP'].includes(input.currency) || !Number.isFinite(Date.parse(input.date))) throw new Error('Invalid sale currency or date.');
    if (!input.items.length) throw new Error('Cart is empty.');
    if (!Number.isFinite(input.exchangeRate) || input.exchangeRate <= 0) throw new Error('Invalid exchange rate.');
    const seen = new Set<string>();
    const items = input.items.map(item => {
      quantity(item.quantity);
      const productId = resolveLocalProductId(branch, item.productId);
      if (seen.has(productId)) throw new Error('Duplicate product line.');
      seen.add(productId);
      const product = branch.products.find(product => product.id === productId);
      if (!product || product.isActive === false || (branch.allowNegativeStock === false && product.stockQuantity < item.quantity)) throw new Error(`Insufficient stock for ${item.productName}.`);
      if (product.salePrice !== item.salePrice) throw new Error(`Price changed for ${product.name}; refresh the cart.`);
      stock(product.stockQuantity - item.quantity);
      product.stockQuantity -= item.quantity;
      return { ...item, productId: product.id, productName: product.name, barcode: product.barcode, purchasePrice: product.purchasePrice, salePrice: product.salePrice, currency: input.currency };
    });
    const subtotal = money(items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0));
    const sale: Sale = { ...input, cashierName: requireOperator(state).name, id, items, subtotal, total: input.currency === 'USD' ? subtotal : Math.round(subtotal * input.exchangeRate), refunded: false, legacy: false };
    price(sale.total);
    branch.sales.push(sale);
    if(heldSaleId)branch.heldSales=branch.heldSales!.filter(hold=>hold.id!==heldSaleId);
    appendInventoryOperation(state, { type: 'sale', sale }, 'sale:' + id);
    return sale;
  }));
}
export function getRefunds(): Refund[] { return readVisibleCollection('refunds'); }
export function remainingQuantity(sale: Sale, productId: string, refunds = getRefunds()): number {
  const sold = sale.items.find(item => item.productId === productId)?.quantity ?? 0;
  return sold - refunds.filter(refund => refund.saleId === sale.id).reduce((sum, refund) => sum + refund.items.filter(item => item.productId === productId).reduce((sum, item) => sum + item.quantity, 0), 0);
}
export function isFullyRefunded(sale: Sale, refunds = getRefunds()) {
  return sale.items.every(item => remainingQuantity(sale, item.productId, refunds) === 0);
}
export interface RefundRequest { saleId: string; items: RefundItem[] }
export async function addRefundBatch(requests: RefundRequest[], cashierName: string, currency: Currency, exchangeRate: number, id = createTransactionId()): Promise<Refund[]> {
  return commit((state, branch) => retry(branch, id, { requests, cashierName, currency, exchangeRate }, () => {
    if (!['USD', 'LBP'].includes(currency) || !requests.length || requests.length > 100 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) throw new Error('Invalid refund request.');
    const refundDate = new Date().toISOString();
    const refunds = requests.map((request, index) => {
      const sale = branch.sales.find(sale => sale.id === request.saleId);
      if (!sale || !request.items.length) throw new Error('Sale not found or refund is empty.');
      if (sale.legacy) throw new Error('Legacy sale history requires reviewed reconciliation before a new refund. Original records are preserved.');
      const seen = new Set<string>();
      const items = request.items.map(requestedItem => {
        const item = { ...requestedItem, productId: resolveLocalProductId(branch, requestedItem.productId) };
        quantity(item.quantity);
        if (seen.has(item.productId)) throw new Error('Duplicate refund line.');
        seen.add(item.productId);
        const original = sale.items.find(line => line.productId === item.productId);
        if (!original || remainingQuantity(sale, item.productId, branch.refunds) < item.quantity) throw new Error('Refund exceeds the remaining sold quantity.');
        const product = branch.products.find(product => product.id === item.productId);
        if (!product) throw new Error('Restore the archived product before refunding it.');
        stock(product.stockQuantity + item.quantity);
        product.stockQuantity += item.quantity;
        return { ...original, quantity: item.quantity, currency };
      });
      const subtotal = money(items.reduce((sum, item) => sum + item.salePrice * item.quantity, 0));
      const refund: Refund = { id: id + ':' + index, saleId: sale.id, items, totalRefunded: currency === 'USD' ? subtotal : Math.round(subtotal * exchangeRate), currency, exchangeRate, date: refundDate, cashierName: requireOperator(state).name };
      price(refund.totalRefunded);
      branch.refunds.push(refund);
      return refund;
    });
    const saleIds = new Set(refunds.map(refund => refund.saleId));
    appendInventoryOperation(state, { type: 'refund_batch', refunds, originalSales: branch.sales.filter(sale => saleIds.has(sale.id)) }, 'refund_batch:' + id);
    return refunds;
  }));
}
export async function addPartialRefund(saleId: string, items: RefundItem[], cashierName: string, id = createTransactionId()): Promise<Refund> {
  const state=getLocalState();
  if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending) throw new Error('Refunds are paused pending reviewed branch attribution. Original history remains unchanged.');
  const sale = getSales().find(sale => sale.id === saleId);
  if (!sale) throw new Error('Sale not found.');
  return (await addRefundBatch([{ saleId, items }], cashierName, sale.currency, sale.exchangeRate, id))[0];
}
export async function deleteProduct(id: string): Promise<string> {
  return commit((state, branch) => {
    if (!branch.products.some(product => product.id === id)) throw new Error('Product not found.');
    if (branch.sales.some(sale => sale.items.some(item => item.productId === id && remainingQuantity(sale, id, branch.refunds) > 0))) throw new Error('Product has refundable sales; keep it available for refunds.');
    branch.products.find(product => product.id === id)!.isActive = false;
    return appendInventoryOperation(state, { type: 'product_delete', productId: id });
  }, true);
}
export function getLowStockProducts(threshold = 5) { return getProducts().filter(product => product.stockQuantity > 0 && product.stockQuantity <= threshold); }
export function getOutOfStockProducts() { return getProducts().filter(product => product.stockQuantity <= 0); }
export function getInventoryEntries(): InventoryEntry[] { return readVisibleCollection('entries'); }
export async function updateInventoryEntry(id: string, updates: Partial<InventoryEntry>): Promise<string> {
  return commit((state, branch) => {
    const entry = branch.entries.find(entry => entry.id === id);
    if (!entry) throw new Error('Receipt not found.');
    if (Object.keys(updates).some(key => !['salesmanName', 'date'].includes(key))) throw new Error('Receipt quantities and prices are immutable. Create an adjustment instead.');
    if (updates.date && !Number.isFinite(Date.parse(updates.date))) throw new Error('Invalid receipt date.');
    Object.assign(entry, updates);
    return appendInventoryOperation(state, { type: 'inventory_entry_update', entryId: id, updates });
  }, true);
}
export async function deleteInventoryEntry(_id: string): Promise<string> {
  throw new Error('Inventory receipt history cannot be deleted. Use an adjustment.');
}
export async function addInventoryEntry(input: Omit<InventoryEntry, 'id'>, id = createTransactionId()): Promise<InventoryEntry> {
  return commit((state, branch) => retry(branch, id, input, () => {
    if (!Number.isFinite(Date.parse(input.date))) throw new Error('Invalid receipt date.');
    quantity(input.quantityAdded); price(input.purchasePrice); price(input.salePrice);
    const barcode = input.barcode.trim();
    if (!barcode || !input.productName.trim()) throw new Error('Name and barcode are required.');
    let product = branch.products.find(product => product.barcode === barcode);
    if (product) {
      stock(product.stockQuantity + input.quantityAdded);
      product.stockQuantity += input.quantityAdded;
      product.isActive = true;
      product.purchasePrice = input.purchasePrice; product.salePrice = input.salePrice; product.name = input.productName.trim();
    } else {
      product = { id: createTransactionId(), barcode, name: input.productName.trim(), stockQuantity: input.quantityAdded, purchasePrice: input.purchasePrice, salePrice: input.salePrice };
      branch.products.push(product);
    }
    const entry = { ...input, barcode, productName: input.productName.trim(), productId: product.id, id, legacy: false };
    branch.entries.push(entry);
    appendInventoryOperation(state, { type: 'receive', entry, product: { ...product } }, id);
    return entry;
  }), true);
}

export function getExchangeRate(): number { return readBranchPreferences().exchangeRate; }
export function getAllowNegativeStock(): boolean { return readBranchPreferences().allowNegativeStock; }
export async function setAllowNegativeStock(enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') throw new Error('Invalid stock policy.');
  const { cloudSynchronizationEnabled } = await import('./inventorySync');
  if (cloudSynchronizationEnabled()) throw new Error('Cloud stock policy is controlled by the approved branch configuration.');
  await localTransaction(state => { requireOperator(state, true); activeBranch(state).allowNegativeStock = enabled; });
}
export async function setExchangeRate(rate: number): Promise<void> {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid exchange rate.');
  await localTransaction(state => { requireOperator(state, true); activeBranch(state).exchangeRate = rate; });
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
  return businessDate();
}
