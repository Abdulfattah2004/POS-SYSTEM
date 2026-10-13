import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const native=vi.hoisted(()=>({enabled:false,invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({isTauri:()=>native.enabled,invoke:native.invoke}));
import { initializeStore, addSale, getProducts, addInventoryEntry } from './store';
import { addUser, login } from './localAuth';
import { getLocalState, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { exportNativeRecoveryBackup, recoverLegacyBranch } from './recovery';
import { loadInventoryFromSupabase, syncPendingInventory, setInventoryAssociation } from './inventorySync';
import { supabaseClient } from './supabase';
const association={businessId:'business',branchId:'main',businessName:'Daily Supermarket',branchName:'Main Branch',ownerUserId:'owner'};
beforeEach(async()=>{
  native.enabled=false;vi.resetAllMocks();localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();
  await addUser({username:'admin',name:'Admin',password:'synthetic-administrator',role:'admin'},true);await login('admin','synthetic-administrator');
});
afterEach(()=>{native.enabled=false;vi.restoreAllMocks();vi.unstubAllEnvs();});
it('requires a complete native verified backup receipt, retaining original legacy storage',async()=>{
  native.enabled=true;localStorage.setItem('pos_sales','original JSON retained');
  native.invoke.mockResolvedValue({id:'export-fixture',directory:'C:/Synthetic',database:'C:/Synthetic/pos_v2.db',sha256:'a'.repeat(64),stateSha256:'b'.repeat(64),stateRevision:1});
  expect((await exportNativeRecoveryBackup()).id).toBe('export-fixture');
  expect(native.invoke).toHaveBeenCalledWith('export_sqlite_recovery',{legacyStorage:{pos_sales:'original JSON retained'}});
  expect(localStorage.getItem('pos_sales')).toBe('original JSON retained');
  native.invoke.mockResolvedValue({id:'incomplete'});await expect(exportNativeRecoveryBackup()).rejects.toThrow('verification was incomplete');
});
it('cannot perform native recovery without fresh authenticated owner authorization',async()=>{
  native.enabled=true;vi.spyOn(supabaseClient!.auth,'getUser').mockResolvedValue({data:{user:null},error:null} as never);
  await expect(recoverLegacyBranch(association,{id:'export-fixture'} as never,'Daily Supermarket / Main Branch')).rejects.toThrow('cannot authorize');
  expect(native.invoke).not.toHaveBeenCalled();
});
it('keeps connection saved but blocks transactions and cloud effects until recovered inventory is reconciled',async()=>{
  await setInventoryAssociation(association);
  await addInventoryEntry({productId:'',productName:'Coffee',barcode:'201',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-12'});
  await localTransaction(state=>{state.legacyBranchRecovery={backupId:'export-fixture',backupSHA256:'a'.repeat(64),businessId:'business',branchId:'main',reconciliationPending:true};});
  vi.stubEnv('VITE_POS_SYNC_ENABLED','true');const rpc=vi.spyOn(supabaseClient!,'rpc');const before=getLocalState().outbox;
  expect(await syncPendingInventory()).toEqual([]);await expect(loadInventoryFromSupabase()).rejects.toThrow('reconciled');
  expect(rpc).not.toHaveBeenCalled();expect(getLocalState().outbox).toEqual(before);
  const p=getProducts()[0];await expect(addSale({items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,salePrice:2,purchasePrice:1,currency:'USD'}],subtotal:4,total:4,currency:'USD',exchangeRate:89500,cashierName:'Admin',date:'2026-10-12',refunded:false},'supported-offline-sale')).rejects.toThrow('paused');
  expect(getProducts()[0].stockQuantity).toBe(10);expect(getLocalState().outbox).toHaveLength(before.length);expect(rpc).not.toHaveBeenCalled();
});
