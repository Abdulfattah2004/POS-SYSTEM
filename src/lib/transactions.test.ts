import { addUser, login } from './localAuth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeStore, addInventoryEntry, addSale, addPartialRefund, addRefundBatch, getSales, getProducts, getRefunds, updateProductStock, updateInventoryEntry, updateProduct, deleteProduct, getRefundableItemsByBarcode, getProductByBarcode } from './store';
import { resetLocalDatabaseForTests, localTransaction, getLocalState, reloadLocalState } from './localDatabase';
import { getPendingInventoryOperations } from './inventorySync';

const receipt = { productId: '', productName: 'Coffee', barcode: 'coffee', quantityAdded: 3, purchasePrice: 2, salePrice: 10, salesmanName: 'Sam', date: '2026-09-30T10:00:00Z' };
function saleInput(quantity = 1) {
  const product = getProducts()[0];
  return { items: [{ productId: product.id, productName: product.name, barcode: product.barcode, quantity, salePrice: product.salePrice, purchasePrice: product.purchasePrice, currency: 'USD' as const }], subtotal: 999, total: 999, currency: 'USD' as const, exchangeRate: 89500, cashierName: 'Cashier', date: '2026-09-30T11:00:00Z', refunded: false };
}
beforeEach(async () => { localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore();
    await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
    await login('admin', 'correct-horse-battery');
    await localTransaction(state => { state.branches.unassigned.allowNegativeStock=false; }); });
describe('atomic local transactions', () => {
  it('negative-stock sales, refunds and receipts remain atomic and idempotent after restart',async()=>{
    await localTransaction(state=>{state.branches.unassigned.allowNegativeStock=true;});
    await addInventoryEntry(receipt,'negative-receipt');
    const input=saleInput(5);const sold=await addSale(input,'negative-sale');
    expect(getProducts()[0].stockQuantity).toBe(-2);
    await addSale(input,'negative-sale');await reloadLocalState();expect(getProducts()[0].stockQuantity).toBe(-2);
    await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'Admin','negative-refund');
    expect(getProducts()[0].stockQuantity).toBe(-1);
    await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'Admin','negative-refund');
    await addInventoryEntry({...receipt,quantityAdded:1},'negative-topup');await addInventoryEntry({...receipt,quantityAdded:1},'negative-topup');
    await reloadLocalState();expect(getProducts()[0].stockQuantity).toBe(0);expect(getSales()).toHaveLength(1);expect(getRefunds()).toHaveLength(1);
  });
  it('refund scanning retains archived original identity after barcode and price changes', async () => {
    await addInventoryEntry(receipt, 'scan-receipt');
    const sale = await addSale(saleInput(2), 'scan-sale');
    await updateProduct(sale.items[0].productId, { barcode: 'coffee-new', name: 'Renamed', salePrice: 20 }, 'scan-edit');
    await localTransaction(state => { state.branches.unassigned.products[0].isActive = false; });
    expect(getProductByBarcode('coffee-new')).toBeUndefined();
    for (const barcode of ['coffee', 'coffee-new']) {
      const [match] = getRefundableItemsByBarcode(barcode);
      expect(match.item).toMatchObject({ barcode: 'coffee', productName: 'Coffee', salePrice: 10 });
      expect(match.remaining).toBe(2);
      expect(match.product.isActive).toBe(false);
    }
    await addPartialRefund(sale.id, [{ ...sale.items[0], quantity: 1 }], 'Admin', 'scan-refund');
    expect(getRefundableItemsByBarcode('coffee')[0].remaining).toBe(1);
    expect(getSales()[0]).toEqual(sale);
  });
  it('reused historical barcode requires original-receipt selection instead of guessing a product', async () => {
    await addInventoryEntry(receipt, 'old-receipt');
    const oldSale = await addSale(saleInput(), 'old-sale');
    await updateProduct(oldSale.items[0].productId, { barcode: 'coffee-renamed' }, 'old-edit');
    await addInventoryEntry({ ...receipt, productName: 'Different coffee' }, 'new-receipt');
    const newer = getProducts().find(product => product.barcode === 'coffee')!;
    await addSale({ ...saleInput(), items: [{ ...oldSale.items[0], productId: newer.id, productName: newer.name, barcode: newer.barcode }] }, 'new-sale');
    expect(() => getRefundableItemsByBarcode('coffee')).toThrow('different historical products');
    expect(getRefunds()).toEqual([]);
    expect(getRefundableItemsByBarcode('coffee-renamed')[0].sale.id).toBe(oldSale.id);
  });
  it('commits receipt, stock and queue together and survives reopening', async () => {
    await addInventoryEntry(receipt, 'receipt-1');
    await reloadLocalState();
    expect(getProducts()[0].stockQuantity).toBe(3);
    expect(getLocalState().branches.unassigned.entries).toHaveLength(1);
    expect(getPendingInventoryOperations()).toHaveLength(1);
  });
  it('aborts every write when a transaction fails', async () => {
    await expect(localTransaction(state => { state.outbox.length = 0; state.recovery.push('partial'); throw new Error('injected'); })).rejects.toThrow('injected');
    await reloadLocalState();
    expect(getLocalState().recovery).not.toContain('partial');
  });
  it('storage quota failure leaves stock, receipt and outbox unchanged', async () => {
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    await expect(addInventoryEntry(receipt)).rejects.toThrow('Storage is full');
    put.mockRestore();
    await reloadLocalState();
    expect(getProducts()).toEqual([]);
    expect(getLocalState().outbox).toEqual([]);
    expect(getLocalState().branches.unassigned.entries).toEqual([]);
  });
  it('receipt retries do not add stock twice and reject conflicting reuse', async () => {
    const first = await addInventoryEntry(receipt, 'receipt-1');
    expect(await addInventoryEntry(receipt, 'receipt-1')).toEqual(first);
    expect(getProducts()[0].stockQuantity).toBe(3);
    await expect(addInventoryEntry({ ...receipt, quantityAdded: 4 }, 'receipt-1')).rejects.toThrow('different data');
  });
  it('rechecks stock and serializes competing checkouts', async () => {
    await addInventoryEntry({ ...receipt, quantityAdded: 1 });
    const input = saleInput();
    const outcomes = await Promise.allSettled([addSale(input, 'a'), addSale(input, 'b')]);
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(getSales()).toHaveLength(1);
    expect(getProducts()[0].stockQuantity).toBe(0);
  });
  it('rolls back earlier line deductions if a later line fails', async () => {
    await addInventoryEntry(receipt);
    const input = saleInput();
    input.items.push({ ...input.items[0], productId: 'missing' });
    await expect(addSale(input)).rejects.toThrow('Insufficient stock');
    expect(getSales()).toEqual([]);
    expect(getProducts()[0].stockQuantity).toBe(3);
    expect(getPendingInventoryOperations()).toHaveLength(1);
  });
  it('persists full sale once, calculates totals and deduplicates after queue acknowledgment', async () => {
    await addInventoryEntry(receipt);
    const input = saleInput(2);
    const sale = await addSale(input, 'sale-1');
    await localTransaction(state => { state.outbox = []; });
    expect(await addSale(input, 'sale-1')).toEqual(sale);
    expect(sale.total).toBe(20);
    expect(getProducts()[0].stockQuantity).toBe(1);
    expect(getSales()).toHaveLength(1);
  });
  it('preserves original sale, derives refund prices and prevents excessive repeat refunds', async () => {
    await addInventoryEntry(receipt);
    const sale = await addSale(saleInput(2));
    const item = { ...sale.items[0], quantity: 1, salePrice: 900 };
    const refund = await addPartialRefund(sale.id, [item], 'Cashier', 'refund-1');
    expect(refund.totalRefunded).toBe(10);
    expect(getSales()[0]).toEqual(sale);
    await addPartialRefund(sale.id, [item], 'Cashier', 'refund-1');
    expect(getRefunds()).toHaveLength(1);
    await expect(addPartialRefund(sale.id, [{ ...item, quantity: 2 }], 'Cashier')).rejects.toThrow('remaining');
    expect(getProducts()[0].stockQuantity).toBe(2);
  });
  it('refund batch rolls back all sales if one is invalid', async () => {
    await addInventoryEntry(receipt);
    const sale = await addSale(saleInput());
    await expect(addRefundBatch([{ saleId: sale.id, items: sale.items }, { saleId: 'missing', items: sale.items }], 'Cashier', 'LBP', 90000)).rejects.toThrow();
    expect(getRefunds()).toEqual([]);
    expect(getProducts()[0].stockQuantity).toBe(2);
  });
  it('refund settlement matches selected currency and rate', async () => {
    await addInventoryEntry(receipt);
    const sale = await addSale(saleInput());
    const [refund] = await addRefundBatch([{ saleId: sale.id, items: sale.items }], 'Cashier', 'LBP', 90000);
    expect(refund.totalRefunded).toBe(900000);
    expect(refund.exchangeRate).toBe(90000);
    expect(refund.currency).toBe('LBP');
  });
  it('rejects invalid quantities/prices and immutable receipt amount edits', async () => {
    for (const quantityAdded of [-1, 0, 1.5, NaN, Infinity]) await expect(addInventoryEntry({ ...receipt, quantityAdded })).rejects.toThrow();
    await expect(addInventoryEntry({ ...receipt, purchasePrice: -1 })).rejects.toThrow();
    const entry = await addInventoryEntry(receipt);
    await expect(updateInventoryEntry(entry.id, { quantityAdded: 9 })).rejects.toThrow('immutable');
    await updateProductStock(entry.productId, -1, 'delta-1');
    await updateProductStock(entry.productId, -1, 'delta-1');
    expect(getProducts()[0].stockQuantity).toBe(2);
  });
  it('refuses damaged legacy data without overwriting it', async () => {
    await resetLocalDatabaseForTests();
    localStorage.setItem('pos_sales', '{broken');
    await expect(initializeStore()).rejects.toThrow('damaged');
    expect(localStorage.getItem('pos_sales')).toBe('{broken');
  });
});

 it('resolves stale cart IDs for checkout and refunds after canonical reconciliation', async () => {
   await addInventoryEntry(receipt);
   const input = saleInput(); const oldId = input.items[0].productId;
   await localTransaction(state => { const branch = state.branches.unassigned; branch.products[0].id = 'canonical'; branch.productAliases = { [oldId]: 'canonical' }; });
   const sale = await addSale(input, 'stale-cart');
   expect(sale.items[0].productId).toBe('canonical');
   await addPartialRefund(sale.id, [{ ...sale.items[0], productId: oldId }], 'Cashier');
   expect(getRefunds()[0].items[0].productId).toBe('canonical');
   expect(getProducts()[0].stockQuantity).toBe(3);
 });
 it('keeps request fingerprints stable across JSON key ordering', async () => {
   const first = await addInventoryEntry(receipt, 'ordered-request');
   const reordered = Object.fromEntries(Object.entries(receipt).reverse()) as typeof receipt;
   expect(await addInventoryEntry(reordered, 'ordered-request')).toEqual(first);
   expect(getProducts()[0].stockQuantity).toBe(3);
 });

 it('preserves exact legacy sale records without inferring missing lines or replaying stock', async () => {
   await addInventoryEntry(receipt); const input = saleInput(); const product = getProducts()[0];
   await resetLocalDatabaseForTests();
   localStorage.setItem('pos_products', JSON.stringify([product]));
   localStorage.setItem('pos_sales', JSON.stringify([{ ...input, id: 'legacy-sale', items: [], subtotal: 0, total: 0, refunded: true }]));
   localStorage.setItem('pos_refunds', JSON.stringify([{ id: 'legacy-refund', saleId: 'legacy-sale', items: input.items, totalRefunded: 10, currency: 'USD', date: input.date, cashierName: 'Cashier' }]));
   localStorage.setItem('pos_inventory_sync_outbox', JSON.stringify([{ operationId: 'already-pending', type: 'stock_delta', productId: product.id, quantityDelta: 1, businessId: null, branchId: null }]));
   await initializeStore();
   expect(getSales()[0].items).toEqual([]);
   expect(getSales()[0].total).toBe(0);
   expect(getSales()[0].refunded).toBe(true);
   expect(getLocalState().legacyStorageArchive?.pos_sales).toBe(localStorage.getItem("pos_sales"));
   expect(getSales()[0].legacy).toBe(true);
   expect(getProducts()[0].stockQuantity).toBe(3);
   expect(getPendingInventoryOperations().map(operation => operation.operationId)).toEqual(['already-pending']);
   expect(localStorage.getItem('pos_sales')).toContain('legacy-sale');
 });

it('rejects amounts that overflow supported precision atomically', async () => {
  await addInventoryEntry(receipt);
  const input = saleInput(); input.currency = 'LBP' as 'USD'; input.exchangeRate = Number.MAX_VALUE;
  await expect(addSale(input)).rejects.toThrow('Price');
  expect(getSales()).toEqual([]);
  expect(getProducts()[0].stockQuantity).toBe(3);
  expect(getPendingInventoryOperations()).toHaveLength(1);
});

it('blocks new refunds of unreconciled legacy sales without changing any balance or queue', async () => {
 await addInventoryEntry(receipt);const sale=await addSale(saleInput(),'legacy-sale');
 await localTransaction(state=>{state.branches.unassigned.sales[0].legacy=true;});const before=getLocalState();
 await expect(addPartialRefund(sale.id,sale.items,'Cashier')).rejects.toThrow('reconciliation');expect(getLocalState()).toEqual(before);
});
it('canonical aliases do not interpret inherited object properties as product IDs', async () => {
 await addInventoryEntry(receipt);const p=getProducts()[0];await localTransaction(state=>{state.branches.unassigned.products[0].id='toString';state.branches.unassigned.productAliases={};});
 const input={...saleInput(),items:[{...saleInput().items[0],productId:'toString'}]};const sale=await addSale(input,'prototype-safe-sale');expect(sale.items[0].productId).toBe('toString');expect(p.stockQuantity).toBe(3);
});

it('queues a multi-receipt refund as one stable atomic cloud operation', async () => {
 await addInventoryEntry(receipt);const a=await addSale(saleInput(),'batch-sale-a');const b=await addSale(saleInput(),'batch-sale-b');
 const request=[{saleId:a.id,items:a.items},{saleId:b.id,items:b.items}];const refunds=await addRefundBatch(request,'Admin','USD',89500,'atomic-batch');
 const operations=getPendingInventoryOperations().filter(o=>o.type==='refund_batch');expect(operations).toHaveLength(1);expect(operations[0]).toMatchObject({operationId:'refund_batch:atomic-batch',refunds});
 await addRefundBatch(request,'Admin','USD',89500,'atomic-batch');expect(getPendingInventoryOperations().filter(o=>o.type==='refund_batch')).toHaveLength(1);expect(getProducts()[0].stockQuantity).toBe(3);
});

it('queues stock and catalog edits as one stable atomic operation',async()=>{const e=await addInventoryEntry(receipt,'edit-receipt');await updateProduct(e.productId,{stockQuantity:7,salePrice:12},'edit');await updateProduct(e.productId,{stockQuantity:7,salePrice:12},'edit');const edits=getPendingInventoryOperations().filter(x=>x.operationId.startsWith('edit:'));expect(edits).toHaveLength(1);expect(edits[0]).toMatchObject({type:'product_adjust',quantityDelta:4,updates:{salePrice:12}});});
it('retains archived catalog in recovery while hiding it from checkout',async()=>{const e=await addInventoryEntry(receipt);await deleteProduct(e.productId);expect(getProducts()).toEqual([]);expect(getLocalState().branches.unassigned.products[0]).toMatchObject({id:e.productId,isActive:false,stockQuantity:3});await reloadLocalState();expect(getProducts()).toEqual([]);});
it('allows eligible returns against inactive catalog without allowing new sales',async()=>{await addInventoryEntry(receipt);const sold=await addSale(saleInput());await localTransaction(state=>{state.branches.unassigned.products[0].isActive=false;});await addPartialRefund(sold.id,sold.items,'Cashier','inactive-return');expect(getLocalState().branches.unassigned.products[0].stockQuantity).toBe(3);expect(getProducts()).toEqual([]);await expect(addSale({...sold,items:sold.items},'inactive-sale')).rejects.toThrow('Insufficient');});

it('refuses the test-only database reset in a production runtime',async()=>{await addInventoryEntry(receipt);vi.stubEnv('MODE','production');try{await expect(resetLocalDatabaseForTests()).rejects.toThrow('isolated tests');expect(getProducts()[0].stockQuantity).toBe(3);}finally{vi.stubEnv('MODE','test');}});
