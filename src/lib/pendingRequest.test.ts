import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {addUser,login} from './localAuth';
import {initializeStore,addInventoryEntry,addSale,addPartialRefund,getProducts,getSales,getRefunds,getInventoryEntries} from './store';
import {CommitUncertainError,getLocalState,initializeLocalDatabase,reloadLocalState,resetLocalDatabaseForTests} from './localDatabase';
import {executePendingRequest,readPendingRequest,savePendingRequest,completePendingRequest} from './pendingRequest';
import {exportRecoveryBackup,restoreRecoveryBackup} from './recovery';

let key:string;
function input(quantity=2) {
  const p=getProducts()[0];return {items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity,salePrice:2,purchasePrice:1,currency:'USD' as const}],subtotal:2*quantity,total:2*quantity,currency:'USD' as const,exchangeRate:89500,cashierName:'Admin',date:'2026-10-12T10:00:00Z',refunded:false};
}
beforeEach(async()=>{
  localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();
  const user=await addUser({username:'admin',name:'Admin',role:'admin',password:'synthetic-test-password'},true);await login('admin','synthetic-test-password');
  key=`pos_checkout_v3:${user.id}:unassigned`;
  await addInventoryEntry({productId:'',productName:'Coffee',barcode:'test-coffee',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-12T09:00:00Z'},'original-receipt');
});
afterEach(()=>vi.restoreAllMocks());
it('full legacy localStorage cannot block durable offline sale, retry, refund or totals',async()=>{
  const legacy=JSON.stringify(Array.from({length:22220},(_,i)=>({id:`original-${i}`,total:i})));localStorage.setItem('pos_sales',legacy);
  const writes=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
  const removals=vi.spyOn(Storage.prototype,'removeItem');
  const request={id:'cash-sale-1',payload:input()};
  const sale=await executePendingRequest(key,request,saved=>addSale(saved.payload,saved.id));
  await initializeLocalDatabase();
  expect(readPendingRequest(key)).toBeNull();expect(getSales()).toHaveLength(1);expect(getSales()[0].total).toBe(4);expect(getProducts()[0].stockQuantity).toBe(8);
  // Lost success response followed by a repeated original request.
  await executePendingRequest(key,request,saved=>addSale(saved.payload,saved.id));
  const refund={id:'refund-1',payload:{saleId:sale.id,items:[{...sale.items[0],quantity:1}]}};
  for(let n=0;n<2;n++)await executePendingRequest(key.replace('pos_checkout_v3:','pos_pending_v3:refund:'),refund,saved=>addPartialRefund(saved.payload.saleId,saved.payload.items,'Admin',saved.id));
  await reloadLocalState();expect(getProducts()[0].stockQuantity).toBe(9);expect(getSales()).toHaveLength(1);expect(getRefunds()).toHaveLength(1);expect(getRefunds()[0].totalRefunded).toBe(2);expect(getInventoryEntries()).toHaveLength(1);
  expect(localStorage.getItem('pos_sales')).toBe(legacy);expect(writes).not.toHaveBeenCalled();expect(removals).not.toHaveBeenCalled();
});
it('failed durable preparation prevents any sale or stock change',async()=>{
  const apply=vi.fn();vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw new DOMException('disk full','QuotaExceededError');});
  await expect(executePendingRequest(key,{id:'not-sold',payload:input()},apply)).rejects.toThrow('disk full');
  await reloadLocalState();expect(apply).not.toHaveBeenCalled();expect(getSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(10);expect(readPendingRequest(key)).toBeNull();
});
it('lost sale confirmation survives restart with original ID and exactly one stock effect',async()=>{
  const request={id:'lost-sale-confirmation',payload:input()};
  await expect(executePendingRequest(key,request,async saved=>{await addSale(saved.payload,saved.id);throw new CommitUncertainError();})).rejects.toMatchObject({uncertainCommit:true});
  await initializeLocalDatabase();const saved=readPendingRequest<typeof request>(key)!;expect(saved).toEqual(request);
  await executePendingRequest(key,saved,retry=>addSale(retry.payload,retry.id));
  expect(getSales()).toHaveLength(1);expect(getProducts()[0].stockQuantity).toBe(8);expect(readPendingRequest(key)).toBeNull();
});
it('failed cleanup after committed sale retains recoverable ID across restart',async()=>{
  const request={id:'lost-cleanup',payload:input()};
  await expect(executePendingRequest(key,request,async saved=>{
    const result=await addSale(saved.payload,saved.id);
    vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw new Error('cleanup failed');});return result;
  })).rejects.toMatchObject({uncertainCommit:true});
  await initializeLocalDatabase();expect(readPendingRequest(key)).toEqual(request);
  await executePendingRequest(key,request,retry=>addSale(retry.payload,retry.id));
  expect(getSales()).toHaveLength(1);expect(getProducts()[0].stockQuantity).toBe(8);expect(readPendingRequest(key)).toBeNull();
});
it('legacy request is imported before checkout and tombstone prevents restart replay without deleting it',async()=>{
  const request={id:'legacy-pending-id',payload:input()};const original=JSON.stringify(request);localStorage.setItem(key,original);
  await executePendingRequest(key,readPendingRequest<typeof request>(key)!,retry=>addSale(retry.payload,retry.id));
  await initializeLocalDatabase();expect(readPendingRequest(key)).toBeNull();expect(localStorage.getItem(key)).toBe(original);expect(getSales()[0].id).toBe('legacy-pending-id');
});
it('rejects replacement or wrong completion ID and refuses portable restore that would drop pending requests',async()=>{
  const request={id:'original-pending',payload:input()};await savePendingRequest(key,request);
  await expect(savePendingRequest(key,{...request,id:'replacement'})).rejects.toThrow('original transaction');
  await expect(completePendingRequest(key,'different-id')).rejects.toThrow('changed');
  const backup=exportRecoveryBackup();expect(JSON.parse(backup).data.pendingRequests[key]).toEqual(request);
  await expect(restoreRecoveryBackup(backup)).rejects.toThrow('unfinished local transactions');
  expect(getLocalState().pendingRequests?.[key]).toEqual(request);
});
it('definitely rejected sale can be corrected without deleting legacy data',async()=>{
  const apply=vi.fn().mockRejectedValue(new Error('invalid quantity'));
  await expect(executePendingRequest(key,{id:'invalid',payload:input()},apply)).rejects.toThrow('invalid quantity');
  expect(readPendingRequest(key)).toBeNull();expect(getSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(10);
});
