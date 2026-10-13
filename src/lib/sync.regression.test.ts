import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initializeStore, addInventoryEntry, addSale, getProducts, getSales } from './store';
import { addUser, login, logout, getCurrentUser } from './localAuth';
import { initializeLocalDatabase, getLocalState, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { bindUnassignedInventoryOperations, getPendingInventoryOperations, loadInventoryFromSupabase, retryInventoryOperations, setInventoryAssociation, syncPendingInventory, signOutSupabaseOwner } from './inventorySync';
import { supabaseClient } from './supabase';
const association = { businessId: 'business', branchId: 'branch', businessName: 'Shop', branchName: 'Main', ownerUserId: 'owner' };
const receipt = { productId: '', productName: 'Coffee', barcode: 'coffee', quantityAdded: 5, purchasePrice: 2, salePrice: 4, salesmanName: 'Sam', date: '2026-09-30' };
beforeEach(async () => {
  vi.stubEnv('VITE_POS_SYNC_ENABLED', 'true');
  localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore();
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  vi.spyOn(supabaseClient!, 'rpc').mockResolvedValue({ data: null, error: { message: 'v2 not deployed in test' } } as never);
  vi.spyOn(supabaseClient!.auth, 'getUser').mockResolvedValue({ data: { user: { id: 'owner' } }, error: null } as never);
});
afterEach(async () => { await syncPendingInventory(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function rpc(handler: (name: string, args: Record<string, unknown> | undefined) => unknown) {
  return vi.spyOn(supabaseClient!, 'rpc').mockImplementation((name, args) => Promise.resolve(handler(name, args)) as never);
}
const protocol = { data: { version: 2, revision: 3, atomic_refund_batches: true, atomic_product_adjustments: true, archived_refund_catalog: true, ledger_preserved: true }, error: null };
it('cloud owner sign-out affects this session and preserves local login, scope, records and pending queue', async () => {
  await setInventoryAssociation(association); await addInventoryEntry(receipt);
  const before=getLocalState();
  const signOut=vi.spyOn(supabaseClient!.auth,'signOut').mockResolvedValue({error:null});
  await signOutSupabaseOwner();
  expect(signOut).toHaveBeenCalledWith({scope:'local'});
  expect(getCurrentUser()?.role).toBe('admin');
  expect(getLocalState()).toEqual(before);
  expect(getPendingInventoryOperations()).toHaveLength(1);
});
it('POS logout clears the local operator without revoking other devices or changing durable data', async () => {
  await setInventoryAssociation(association); await addInventoryEntry(receipt);
  const before=getLocalState();
  const signOut=vi.spyOn(supabaseClient!.auth,'signOut').mockResolvedValue({error:null});
  await logout();
  expect(getCurrentUser()).toBeNull();expect(signOut).not.toHaveBeenCalled();
  expect(getLocalState()).toEqual(before);
});
it('isolates products, sales and receipts across branches without mixing storage', async () => {
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await localTransaction(state => { state.outbox = []; });
  await setInventoryAssociation({ ...association, branchId: 'other' });
  expect(getProducts()).toEqual([]);
  expect(getSales()).toEqual([]);
  await addInventoryEntry({ ...receipt, quantityAdded: 2 });
  await localTransaction(state => { state.outbox = []; });
  await setInventoryAssociation(association);
  expect(getProducts()[0].stockQuantity).toBe(5);
});
it('refuses branch switching while associated work is unresolved', async () => {
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await expect(setInventoryAssociation({ ...association, branchId: 'other' })).rejects.toThrow('Resolve');
});
it('binds original offline records and IDs once without recreating operations', async () => {
  await addInventoryEntry(receipt, 'offline-receipt');
  await setInventoryAssociation(association);
  await bindUnassignedInventoryOperations();
  expect(getProducts()[0].stockQuantity).toBe(5);
  expect(getPendingInventoryOperations()[0].operationId).toBe('offline-receipt');
  expect(await bindUnassignedInventoryOperations()).toBe(0);
});
it('blocks unsafe legacy RPCs and retains queued records', async () => {
  const mock = rpc(() => ({ data: null, error: { message: 'function missing' } }));
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await syncPendingInventory();
  expect(mock.mock.calls.every(call => call[0] === 'pos_sync_protocol')).toBe(true);
  expect(getPendingInventoryOperations()).toHaveLength(1);
});
it('reconciles canonical product IDs before sending the dependent full sale', async () => {
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const sent: Record<string, unknown>[] = [];
  let originalId = '';
  const mock = vi.spyOn(supabaseClient!, 'rpc').mockImplementation((name, args) => {
    if (name === 'pos_sync_protocol') return Promise.resolve(protocol) as never;
    const operation = (args as { p_operation: Record<string, unknown> }).p_operation;
    sent.push(operation);
    if (operation.type === 'receive') return pending as never;
    return Promise.resolve({ data: { confirmed: true, operation_id: operation.operationId, product_ids: { canonical: 'canonical' } }, error: null }) as never;
  });
  await setInventoryAssociation(association);
  const entry = await addInventoryEntry(receipt);
  originalId = entry.productId;
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const product = getProducts()[0];
  await addSale({ items: [{ productId: product.id, productName: product.name, barcode: product.barcode, quantity: 1, salePrice: 4, purchasePrice: 2, currency: 'USD' }], subtotal: 4, total: 4, currency: 'USD', exchangeRate: 89500, cashierName: 'Admin', date: '2026-09-30', refunded: false }, 'sale-test');
  finish({ data: { confirmed: true, operation_id: entry.id, product_ids: { [originalId]: 'canonical' } }, error: null });
  await syncPendingInventory();
  expect(getProducts()[0]).toMatchObject({ id: 'canonical', stockQuantity: 4 });
  expect(getSales()[0].items[0].productId).toBe('canonical');
  expect((sent[1].sale as { items: { productId: string }[] }).items[0].productId).toBe('canonical');
  expect(mock).toHaveBeenCalled();
});
it('keeps the wire payload and ID identical after a lost response', async () => {
  const sent: unknown[] = [];
  let fail = true;
  rpc((name, args) => {
    if (name === 'pos_sync_protocol') return protocol;
    const operation = args!.p_operation as { operationId: string; product: {id:string} };
    sent.push(operation);
    return fail ? { data: null, error: { message: 'response lost' } } : { data: { confirmed: true, operation_id: operation.operationId, product_ids: {[operation.product.id]:operation.product.id} }, error: null };
  });
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await syncPendingInventory();
  expect(getPendingInventoryOperations()[0].lastError).toBe('response lost');
  fail = false;
  await retryInventoryOperations();
  expect(sent[1]).toEqual(sent[0]);
  expect(getPendingInventoryOperations()).toEqual([]);
});
it('does not overwrite mutations made during cloud refresh', async () => {
  await setInventoryAssociation(association);
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const mock = vi.spyOn(supabaseClient!, 'rpc').mockImplementation(name => name === 'pos_sync_protocol' ? Promise.resolve(protocol) as never : pending as never);
  const refresh = loadInventoryFromSupabase();
  await vi.waitFor(() => expect(mock.mock.calls.some(call => call[0] === 'pos_branch_snapshot')).toBe(true));
  await localTransaction(state => {
    state.branches['business/branch'].products.push({ id: 'new', name: 'New', barcode: 'new', stockQuantity: 3, purchasePrice: 1, salePrice: 2 });
  });
  finish({ data: { products: [], entries: [], sales: [], refunds: [] }, error: null });
  await refresh;
  expect(getProducts()[0].id).toBe('new');
});
it('authoritative cloud snapshots remove remote tombstones and do not truncate at 1000 rows', async () => {
  await setInventoryAssociation(association);
  await localTransaction(state => { state.branches['business/branch'].products.push({ id: 'deleted', name: 'Old', barcode: 'old', stockQuantity: 1, purchasePrice: 1, salePrice: 2 }); });
  rpc(name => name === 'pos_sync_protocol' ? protocol : { data: { products: [...Array.from({ length: 1100 }, (_, index) => ({ id: String(index), barcode: String(index), name: 'Product', stockQuantity: 1, purchasePrice: 1, salePrice: 2 })), {id:'deleted',name:'Old',barcode:'old',stockQuantity:1,purchasePrice:1,salePrice:2,isActive:false}], entries: [], sales: [], refunds: [] }, error: null });
  await loadInventoryFromSupabase();
  expect(getProducts()).toHaveLength(1100);
  expect(getProducts().some(product => product.id === 'deleted')).toBe(false);
});
it('local logout pauses background work without clearing the device owner session', async () => {
  const signout = vi.spyOn(supabaseClient!.auth, 'signOut').mockResolvedValue({ error: null });
  await logout();
  expect(signout).not.toHaveBeenCalled();
  expect(await syncPendingInventory()).toEqual([]);
});

it('quarantines canonical collisions and refuses further transactions until reconciliation', async () => {
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt); await syncPendingInventory();
  const operation = getPendingInventoryOperations()[0];
  const originalId = getProducts()[0].id;
  await localTransaction(state => { state.branches['business/branch'].products.push({ ...state.branches['business/branch'].products[0], id: 'canonical', barcode: 'different', stockQuantity: 7 }); });
  rpc(name => name === 'pos_sync_protocol' ? protocol : { data: { confirmed: true, operation_id: operation.operationId, product_ids: { [originalId]: 'canonical' } }, error: null });
  await retryInventoryOperations();
  expect(getPendingInventoryOperations()[0].blocked).toBe(true);
  expect(getProducts().map(product => product.stockQuantity)).toEqual([5, 7]);
  await expect(addInventoryEntry(receipt)).rejects.toThrow('unresolved cloud conflict');
});
it('allows only an administrator to release a quarantined retry', async () => {
  await addUser({ username: 'cashier', name: 'Cashier', role: 'cashier', password: 'cashier-password-new' });
  await login('cashier', 'cashier-password-new');
  await expect(retryInventoryOperations()).rejects.toThrow('authorization');
});

it('keeps production synchronization disabled unless explicitly configured', async () => {
  vi.stubEnv('VITE_POS_SYNC_ENABLED', 'false');
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await syncPendingInventory();
  await loadInventoryFromSupabase();
  expect(supabaseClient!.rpc).not.toHaveBeenCalled();
  expect(getPendingInventoryOperations()).toHaveLength(1);
});
it('administrator retry cannot release quarantined historical operations', async () => {
  await setInventoryAssociation(association);
  await addInventoryEntry(receipt);
  await localTransaction(state => { state.outbox[0].quarantined = 'unknown historical completion'; state.outbox[0].blocked = true; });
  rpc(() => protocol);
  await retryInventoryOperations();
  expect(getPendingInventoryOperations()[0].blocked).toBe(true);
  expect(supabaseClient!.rpc).not.toHaveBeenCalledWith('pos_commit_operation', expect.anything());
});

it('quarantines the original persisted queue at cutover without changing IDs payloads or balances', async () => {
 await setInventoryAssociation(association);await addInventoryEntry(receipt,'old-queue-id');
 await localTransaction(state=>{delete state.syncRevision;state.outbox[0].wirePayload=JSON.stringify({...state.outbox[0]});});
 const before=getLocalState(); await initializeLocalDatabase();const after=getLocalState();
 expect(after.outbox[0].operationId).toBe(before.outbox[0].operationId);
 expect(after.outbox[0].wirePayload).toBe(before.outbox[0].wirePayload);
 expect(after.branches).toEqual(before.branches);expect(after.outbox[0].quarantined).toContain('Pre-cutover');
});

it('blocks deterministic database integrity conflicts rather than retrying historical collisions indefinitely', async () => {
 const mock=rpc(name=>name==='pos_sync_protocol'?protocol:{data:null,error:{code:'23505',message:'Historical receipt identity collision'}});
 await setInventoryAssociation(association);await addInventoryEntry(receipt);await syncPendingInventory();
 expect(getPendingInventoryOperations()[0].blocked).toBe(true);
 const attempts=mock.mock.calls.filter(c=>c[0]==='pos_commit_operation').length;
 await syncPendingInventory();expect(mock.mock.calls.filter(c=>c[0]==='pos_commit_operation')).toHaveLength(attempts);
});

it('retains a committed local receipt on a partial canonical acknowledgement',async()=>{await setInventoryAssociation(association);const e=await addInventoryEntry(receipt,'partial-ack');await syncPendingInventory();rpc(name=>name==='pos_sync_protocol'?protocol:{data:{confirmed:true,operation_id:e.id,product_ids:{}},error:null});await retryInventoryOperations();expect(getPendingInventoryOperations()).toHaveLength(1);expect(getPendingInventoryOperations()[0].lastError).toContain('canonical');expect(getProducts()[0].stockQuantity).toBe(5);});

it('refuses an incomplete cloud snapshot without deleting local inventory or receipts', async () => {
 await setInventoryAssociation(association); await addInventoryEntry(receipt,'preserved-receipt');
 await localTransaction(state => { state.outbox = []; });
 const before=getLocalState().branches;
 rpc(name=>name==='pos_sync_protocol'?protocol:{data:{products:[],entries:[],sales:[],refunds:[]},error:null});
 await expect(loadInventoryFromSupabase()).rejects.toThrow('omits preserved local products');
 expect(getLocalState().branches).toEqual(before);
});

it('refuses to overwrite preserved historical stock with different cloud balances', async () => {
 await setInventoryAssociation(association); await addInventoryEntry(receipt,'preserved-receipt');
 await localTransaction(state => { state.outbox=[]; state.branches['business/branch'].products[0].legacy=true; });
 const before=getLocalState().branches;
 const products=getProducts().map(product=>({...product,stockQuantity:0}));
 rpc(name=>name==='pos_sync_protocol'?protocol:{data:{products,entries:[],sales:[],refunds:[]},error:null});
 await expect(loadInventoryFromSupabase()).rejects.toThrow('differs from preserved original');
 expect(getLocalState().branches).toEqual(before);
});

it('accepts an exactly reconciled original baseline despite optional active flags, then reads another device stock change',async()=>{
 await setInventoryAssociation(association);await addInventoryEntry(receipt,'reviewed-baseline');
 await localTransaction(state=>{state.outbox=[];const branch=state.branches['business/branch'];branch.products[0].legacy=true;branch.entries[0].legacy=true;});
 const original=getProducts()[0];let stock=original.stockQuantity;
 const {legacy:_migrationFlag,...product}=original;
 rpc(name=>name==='pos_sync_protocol'?protocol:{data:{allowNegativeStock:true,products:[{...product,isActive:true,stockQuantity:stock}],entries:[],sales:[],refunds:[]},error:null});
 await loadInventoryFromSupabase();expect(getProducts()[0]).toMatchObject({id:original.id,stockQuantity:stock,isActive:true});
 expect(getProducts()[0].legacy).toBeUndefined();expect(getLocalState().branches['business/branch'].entries).toHaveLength(1);
 stock-=1;await loadInventoryFromSupabase();expect(getProducts()[0].stockQuantity).toBe(stock);
});

it('keeps background snapshot failures visible inline without changing local inventory',async()=>{
 const {refreshInventorySync}=await import('./inventorySync');const {getNotices}=await import('./notifications');
 await setInventoryAssociation(association);const before=getLocalState().branches;
 rpc(name=>name==='pos_sync_protocol'?protocol:{data:null,error:new Error('Snapshot contract unavailable')});
 await refreshInventorySync();expect(getLocalState().branches).toEqual(before);
 expect(getNotices().some(notice=>notice.kind==='error'&&notice.message.includes('Cloud refresh paused: Snapshot contract unavailable'))).toBe(true);
});
