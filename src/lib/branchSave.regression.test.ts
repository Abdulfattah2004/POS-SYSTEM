import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initializeStore, addSale, getProducts, addInventoryEntry, addPartialRefund } from './store';
import { addUser, login } from './localAuth';
import { emptyBranch, getLocalState, initializeLocalDatabase, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { setInventoryAssociation, syncPendingInventory, loadInventoryFromSupabase, retryInventoryOperations, enqueueInventoryOperation } from './inventorySync';
import { supabaseClient } from './supabase';

const branchIds={palma:'93cbc500-8177-42a8-a74c-4a57c2113956',manar:'12de0c1c-57fe-4367-9016-818f0ee3a88d'};
const selection = {businessId:'1593a757-910c-4e45-8dd2-26436bae0347',branchId:branchIds.palma,businessName:'Daily Supermarket',branchName:'palma',ownerUserId:'owner-id'};
const legacyBranch = () => ({...emptyBranch(),
  products:Array.from({length:243},(_,i)=>({id:`original-product-${i}`,name:`Original product ${i}`,barcode:`original-${i}`,stockQuantity:10,purchasePrice:1,salePrice:2,legacy:true})),
  sales:Array.from({length:22220},(_,i)=>({id:`historical-sale-${i}`,legacy:true,items:[],subtotal:2,total:2,currency:'USD' as const,exchangeRate:89500,cashierName:'Original cashier',date:'2026-10-01',refunded:false})),
  refunds:[{id:'historical-refund',legacy:true,saleId:'historical-sale-0',items:[],totalRefunded:2,currency:'USD' as const,date:'2026-10-01',cashierName:'Original cashier'}],
  entries:[{id:'historical-entry',legacy:true,productId:'original-product-0',productName:'Original product 0',barcode:'original-0',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Original supplier',date:'2026-10-01'}],
});
beforeEach(async () => {
  localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore();
  await addUser({username:'admin',password:'synthetic-admin-password',name:'Admin',role:'admin'},true);
  await login('admin','synthetic-admin-password');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each(['palma','manar'])('saves %s independently and preserves all 22,220 unassigned sales, 243 products and pending IDs', async branchName => {
  await localTransaction(state => {
    state.project1Settings={};state.branches.unassigned=legacyBranch();
    state.outbox=[8,-1].map((quantityDelta,i)=>({type:'stock_delta',operationId:`preserved-queue-${i}`,businessId:null,branchId:null,productId:'original-product-0',quantityDelta,blocked:true,quarantined:'Synthetic historical queue requires review; do not replay.'}));
  });
  const before=getLocalState();
  const next={...selection,branchId:branchIds[branchName as keyof typeof branchIds],branchName};
  await setInventoryAssociation(next);
  await initializeLocalDatabase();
  expect(getLocalState().branches.unassigned).toEqual(before.branches.unassigned);
  expect(getLocalState().outbox).toEqual(before.outbox);
  expect(getLocalState().branches.unassigned.sales).toHaveLength(22220);
  expect(getLocalState().branches.unassigned.products).toHaveLength(243);
  expect(getLocalState().association).toEqual(next);
  expect(getLocalState().outbox.map(operation=>operation.operationId)).toEqual(['preserved-queue-0','preserved-queue-1']);
},20000);
it('saves with full localStorage but blocks checkout and cloud effects against unattributed inventory', async () => {
  await localTransaction(state => {state.project1Settings={};state.branches.unassigned=legacyBranch();});
  localStorage.setItem('pos_sales','retained legacy storage');
  const writes=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Storage full','QuotaExceededError');});
  const product=getProducts()[0];
  const payload={items:[{productId:product.id,productName:product.name,barcode:product.barcode,quantity:2,salePrice:2,purchasePrice:1,currency:'USD' as const}],subtotal:4,total:4,currency:'USD' as const,exchangeRate:89500,date:'2026-10-13',cashierName:'Admin',refunded:false};
  await setInventoryAssociation(selection);
  const before=getLocalState();
  await expect(addSale(payload,'supported-offline-sale')).rejects.toThrow('paused');
  await expect(addInventoryEntry({productId:'',productName:'Unsafe',barcode:'unsafe',quantityAdded:1,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-13'})).rejects.toThrow('paused');
  await expect(addPartialRefund('historical-sale-0',[],'Admin','unsafe-refund')).rejects.toThrow('paused');
  await expect(enqueueInventoryOperation({type:'stock_delta',productId:product.id,quantityDelta:-1})).rejects.toThrow('blocked');
  vi.stubEnv('VITE_POS_SYNC_ENABLED','true'); const rpc=vi.spyOn(supabaseClient!,'rpc');
  expect(await syncPendingInventory()).toEqual([]);
  await expect(loadInventoryFromSupabase()).rejects.toThrow('pending');
  await expect(retryInventoryOperations()).rejects.toThrow('paused');
  await initializeLocalDatabase();
  expect(getLocalState()).toEqual(before); expect(rpc).not.toHaveBeenCalled();
  expect(getLocalState().branches.unassigned.products[0].stockQuantity).toBe(10);
  expect(getLocalState().association).toEqual(selection);expect(localStorage.getItem('pos_sales')).toBe('retained legacy storage');expect(writes).not.toHaveBeenCalled();
},20000);
it('switches palma -> manar -> palma without moving or changing any historical record',async()=>{
  await localTransaction(state=>{state.branches.unassigned=legacyBranch();});
  const original=JSON.stringify(getLocalState().branches.unassigned);
  for(const branchName of ['palma','manar','palma']) {
    await setInventoryAssociation({...selection,branchId:branchIds[branchName as keyof typeof branchIds],branchName}); await initializeLocalDatabase();
    expect(getLocalState().association?.branchId).toBe(branchIds[branchName as keyof typeof branchIds]);expect(JSON.stringify(getLocalState().branches.unassigned)).toBe(original);
  }
  expect(getLocalState().branches[`${selection.businessId}/${branchIds.palma}`].products).toEqual([]);expect(getLocalState().branches[`${selection.businessId}/${branchIds.manar}`].sales).toEqual([]);
},20000);
it('uses retained scope IDs, not case-sensitive names, and never moves original history on saving', async () => {
  await localTransaction(state => {state.project1Settings={business_id:selection.businessId,branch_id:selection.branchId};state.branches.unassigned=legacyBranch();});
  const original=getLocalState().branches.unassigned;
  await setInventoryAssociation({...selection,branchName:'PALMA'}); await initializeLocalDatabase();
  expect(getLocalState().association).toEqual({...selection,branchName:'PALMA'});
  expect(getLocalState().branches.unassigned).toEqual(original);
  expect(getLocalState().branches[`${selection.businessId}/${branchIds.palma}`].sales).toEqual([]);
  expect(getLocalState().outbox).toEqual([]);
},20000);
it('durable save failures preserve the previous branch and history; retry persists without duplicates', async () => {
  await setInventoryAssociation(selection);
  await localTransaction(state=>{state.branches[`${selection.businessId}/${branchIds.palma}`]=legacyBranch();});
  const before=getLocalState();
  vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw new Error('SQLITE_BUSY simulated durable write failure');});
  await expect(setInventoryAssociation({...selection,branchName:'PALMA'})).rejects.toThrow('SQLITE_BUSY');
  await initializeLocalDatabase();expect(getLocalState()).toEqual(before);
  await setInventoryAssociation({...selection,branchName:'PALMA'}); await initializeLocalDatabase();
  expect(getLocalState().association?.branchName).toBe('PALMA');
  expect(getLocalState().branches).toEqual(before.branches);expect(getLocalState().outbox).toEqual(before.outbox);
},20000);
