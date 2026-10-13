import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const native=vi.hoisted(()=>({enabled:false,invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>native.enabled,invoke:native.invoke}));
import {addInventoryEntry,addPartialRefund,addSale,getProducts,initializeStore,updateProductStock} from './store';
import {addUser,login} from './localAuth';
import {emptyBranch,getLocalState,initializeLocalDatabase,localTransaction,originalRecoveryPending,resetLocalDatabaseForTests} from './localDatabase';
import {setInventoryAssociation,enqueueInventoryOperation} from './inventorySync';
import {activateVerifiedBranchInventory,verifyInventoryBaseline} from './inventoryActivation';
import * as sync from './inventorySync';
import {supabaseClient} from './supabase';
import {restoreRecoveryBackup,exportRecoveryBackup} from './recovery';
const selection={businessId:'synthetic-business',branchId:'palma',businessName:'Synthetic Supermarket',branchName:'palma',ownerUserId:'synthetic-owner'};
const key='synthetic-business/palma';
const products=()=>Array.from({length:243},(_,i)=>({id:`original-${i}`,name:`Product ${i}`,barcode:`code-${i}`,stockQuantity:10,purchasePrice:1,salePrice:2,legacy:true}));
beforeEach(async()=>{native.enabled=false;native.invoke.mockReset();localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();await addUser({username:'admin',name:'Admin',role:'admin',password:'synthetic-safe-password'},true);await login('admin','synthetic-safe-password');});
afterEach(()=>{native.enabled=false;vi.restoreAllMocks();vi.unstubAllEnvs();});
it('validates all 243 identities and quantities, accepting only ordering/provenance differences',async()=>{
 await localTransaction(s=>{s.branches.unassigned.products=products();});const state=getLocalState();
 expect(verifyInventoryBaseline(state,[...products()].reverse().map(p=>({...p,legacy:false})))).toHaveLength(243);
 for(const field of ['id','barcode','name','purchasePrice','salePrice','stockQuantity']){
  const cloud=products();Object.assign(cloud[0],{[field]:typeof cloud[0][field as keyof typeof cloud[0]]==='number'?99:'different'});
  expect(()=>verifyInventoryBaseline(state,cloud)).toThrow('differ');
 }
 expect(()=>verifyInventoryBaseline(state,products().slice(1))).toThrow('differ');
 expect(()=>verifyInventoryBaseline(state,[...products(),products()[0]])).toThrow('Duplicate');
});
it('22,220 unassigned sales alone do not prevent safely scoped cash sales',async()=>{
 await localTransaction(s=>{s.branches.unassigned.sales=Array.from({length:22220},(_,i)=>({id:`history-${i}`,legacy:true,items:[],subtotal:2,total:2,currency:'USD',exchangeRate:89500,cashierName:'Original',date:'2020-01-01',refunded:false}));});
 const history=getLocalState().branches.unassigned;
 await setInventoryAssociation(selection);expect(originalRecoveryPending()).toBe(false);
 await addInventoryEntry({productId:'',productName:'Separately scoped',barcode:'scoped',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-13'},'scoped-receipt');
 const p=getProducts()[0];await addSale({items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,purchasePrice:1,salePrice:2,currency:'USD'}],subtotal:4,total:4,currency:'USD',exchangeRate:89500,cashierName:'Admin',date:'2026-10-13',refunded:false},'scoped-cash-sale');
 await initializeLocalDatabase();expect(getProducts()[0].stockQuantity).toBe(8);expect(getLocalState().branches.unassigned).toEqual(history);
},20000);
it('verified inventory supports offline cashier cash sale, restart, exactly-once retry and refund without touching original history or queues',async()=>{
 await addUser({username:'cashier',name:'Cashier',role:'cashier',password:'synthetic-cashier-password'});
 await localTransaction(s=>{s.branches.unassigned.products=products();s.branches.unassigned.sales=Array.from({length:22220},(_,i)=>({id:`history-${i}`,legacy:true,items:[],subtotal:2,total:2,currency:'USD',exchangeRate:89500,cashierName:'Original',date:'2020-01-01',refunded:false}));s.outbox=[{type:'stock_delta',operationId:'preserved-receipt',productId:'original-0',quantityDelta:8,businessId:selection.businessId,branchId:selection.branchId,blocked:true,quarantined:'Original operation; never replay.'},{type:'stock_delta',operationId:'preserved-sale',productId:'original-0',quantityDelta:-1,businessId:null,branchId:null,blocked:true,quarantined:'Original operation; never replay.'}];});
 await setInventoryAssociation(selection);const original=getLocalState().branches.unassigned,originalQueue=getLocalState().outbox;
 expect(originalRecoveryPending()).toBe(true);
 // Browser fixture mirrors the independently tested native backup transaction;
 // production activation is desktop-only and cannot use this fixture setup.
 await localTransaction(s=>{verifyInventoryBaseline(s,products());s.branches[key].products=products().map(p=>({...p,legacy:false}));s.inventoryActivation={businessId:selection.businessId,branchId:selection.branchId,backupId:'synthetic-verified-backup',backupSHA256:'a'.repeat(64),inventorySHA256:'b'.repeat(64),historicalOperationIds:originalQueue.map(op=>op.operationId)};});
 expect(originalRecoveryPending()).toBe(false);await login('cashier','synthetic-cashier-password');
 vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Full legacy localStorage','QuotaExceededError');});
 const p=getProducts()[0],input={items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,purchasePrice:1,salePrice:2,currency:'USD' as const}],subtotal:4,total:4,currency:'USD' as const,exchangeRate:89500,cashierName:'Cashier',date:'2026-10-13',refunded:false};
 const before=getLocalState();vi.spyOn(IDBObjectStore.prototype,'put').mockImplementationOnce(()=>{throw new Error('Simulated SQLite write failure');});
 await expect(addSale(input,'cash-sale')).rejects.toThrow('write failure');await initializeLocalDatabase();expect(getLocalState()).toEqual(before);
 const sale=await addSale(input,'cash-sale');await initializeLocalDatabase();await addSale(input,'cash-sale');
 expect(getProducts()[0].stockQuantity).toBe(8);expect(getLocalState().branches[key].sales).toHaveLength(1);
 await addPartialRefund(sale.id,[{...sale.items[0],quantity:1}],'Cashier','cash-refund');await initializeLocalDatabase();await addPartialRefund(sale.id,[{...sale.items[0],quantity:1}],'Cashier','cash-refund');
 expect(getProducts()[0].stockQuantity).toBe(9);expect(getLocalState().branches[key].refunds).toHaveLength(1);
 expect(getLocalState().branches.unassigned).toEqual(original);expect(getLocalState().outbox.slice(0,2)).toEqual(originalQueue);
 expect(getLocalState().outbox.slice(2).map(op=>op.type)).toEqual(['sale','refund_batch']);
 await expect(setInventoryAssociation({...selection,branchId:'manar',branchName:'manar'})).rejects.toThrow('Administrator');
 await login('admin','synthetic-safe-password');await expect(enqueueInventoryOperation({type:'stock_delta',productId:p.id,quantityDelta:8},'preserved-receipt')).rejects.toThrow('Historical operation');
 await expect(restoreRecoveryBackup(exportRecoveryBackup())).rejects.toThrow('ownership proof');
 // Pending current-branch operations must finish before a connection switch.
 await localTransaction(s=>{s.outbox=originalQueue;});
 await setInventoryAssociation({...selection,branchId:'manar',branchName:'manar'});expect(originalRecoveryPending()).toBe(true);
 await expect(addSale(input,'wrong-branch-sale')).rejects.toThrow('paused');
 await setInventoryAssociation(selection);expect(originalRecoveryPending()).toBe(false);await updateProductStock(p.id,1,'new-stock-adjustment');expect(getProducts()[0].stockQuantity).toBe(10);
 expect(getLocalState().branches.unassigned).toEqual(original);expect(getLocalState().outbox.slice(0,2)).toEqual(originalQueue);
},30000);

const backup={id:'export-synthetic',database:'Synthetic/pos_v2.db',directory:'Synthetic',sha256:'a'.repeat(64),stateSha256:'b'.repeat(64),stateRevision:1};
async function prepareNativeReview(){
 await localTransaction(s=>{s.branches.unassigned.products=products();});await setInventoryAssociation(selection);
 vi.spyOn(sync,'getCurrentOwnerBusinessBranches').mockResolvedValue([{id:selection.businessId,name:selection.businessName,branches:[{id:selection.branchId,name:selection.branchName}]}]);
 vi.spyOn(sync,'verifySyncProtocol').mockResolvedValue(undefined);
 vi.spyOn(supabaseClient!.auth,'getUser').mockResolvedValue({data:{user:{id:selection.ownerUserId}},error:null} as never);
 vi.spyOn(supabaseClient!,'rpc').mockResolvedValue({data:{products:products(),allowNegativeStock:false},error:null} as never);
 native.enabled=true;
}
it('inventory activation requires an authenticated owner of the exact selected branch before invoking native mutation',async()=>{
 await prepareNativeReview();vi.mocked(supabaseClient!.auth.getUser).mockResolvedValue({data:{user:{id:'foreign-owner'}},error:null} as never);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('cannot authorize');expect(native.invoke).not.toHaveBeenCalled();expect(supabaseClient!.rpc).not.toHaveBeenCalled();
 vi.mocked(supabaseClient!.auth.getUser).mockResolvedValue({data:{user:{id:selection.ownerUserId}},error:null} as never);vi.mocked(sync.getCurrentOwnerBusinessBranches).mockResolvedValue([{id:selection.businessId,name:'Synthetic',branches:[{id:'manar',name:'manar'}]}]);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('cannot authorize');expect(native.invoke).not.toHaveBeenCalled();
});
it('activation rejects cloud balance conflicts and changed owner sessions without invoking native mutation',async()=>{
 await prepareNativeReview();vi.mocked(supabaseClient!.rpc).mockResolvedValueOnce({data:{products:products().slice(1)},error:null} as never);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('differ');expect(native.invoke).not.toHaveBeenCalled();
 vi.mocked(supabaseClient!.auth.getUser).mockResolvedValueOnce({data:{user:{id:selection.ownerUserId}},error:null} as never).mockResolvedValueOnce({data:{user:{id:'foreign-owner'}},error:null} as never);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('session changed');expect(native.invoke).not.toHaveBeenCalled();
});
it('activation uses one native transaction and verifies durable proof and untouched history before reporting success',async()=>{
 await prepareNativeReview();const before=getLocalState();const result=structuredClone(before);result.revision++;
 result.inventoryActivation={businessId:selection.businessId,branchId:selection.branchId,backupId:backup.id,backupSHA256:backup.sha256,inventorySHA256:'c'.repeat(64),historicalOperationIds:[]};result.branches[key].products=products().map(p=>({...p,legacy:false}));
 native.invoke.mockImplementation(async command=>{if(command==='activate_verified_inventory'||command==='read_pos_state')return result;throw new Error('Unexpected command');});
 await activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma');
 expect(native.invoke).toHaveBeenCalledWith('activate_verified_inventory',{association:selection,backupId:backup.id,confirmation:'Synthetic Supermarket / palma',cloudProducts:products(),cloudAllowNegativeStock:false});expect(native.invoke).toHaveBeenCalledWith('read_pos_state');expect(getLocalState().branches.unassigned).toEqual(before.branches.unassigned);
});
it('activation does not accept an unpersisted native proof or cashier authorization',async()=>{
 await addUser({username:'cashier',name:'Cashier',role:'cashier',password:'synthetic-cashier-password'});await prepareNativeReview();const before=getLocalState();
 const result={...before,revision:before.revision+1,inventoryActivation:{businessId:selection.businessId,branchId:selection.branchId,backupId:backup.id,backupSHA256:backup.sha256,inventorySHA256:'c'.repeat(64),historicalOperationIds:[]}};
 native.invoke.mockImplementation(async command=>command==='activate_verified_inventory'?result:before);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('confirmation was lost');
 native.enabled=false;await login('cashier','synthetic-cashier-password');native.enabled=true;native.invoke.mockClear();
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('Administrator');expect(native.invoke).not.toHaveBeenCalled();
});

it('an original WebView checkout envelope blocks activation without discarding its ID or payload',async()=>{
 await prepareNativeReview();const request=JSON.stringify({id:'original-retry-id',payload:{quantity:2}});localStorage.setItem('pos_checkout_v3:original:unassigned',request);
 await expect(activateVerifiedBranchInventory(backup,'Synthetic Supermarket / palma')).rejects.toThrow('Unfinished original transactions');expect(native.invoke).not.toHaveBeenCalled();expect(supabaseClient!.rpc).not.toHaveBeenCalled();expect(localStorage.getItem('pos_checkout_v3:original:unassigned')).toBe(request);
});
