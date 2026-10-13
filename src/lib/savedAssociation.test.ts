import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initializeStore, addInventoryEntry, getProducts, addSale, getSales, addPartialRefund, getRefunds } from './store';
import { addUser, login, logout } from './localAuth';
import { getLocalState, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { getInventoryAssociation, setInventoryAssociation, signInSupabaseOwner, signOutSupabaseOwner, loadInventoryFromSupabase } from './inventorySync';
import { supabaseClient } from './supabase';
import { getCloudConnectionIssue, setCloudConnectionIssue } from './cloudConnectionStatus';
const association = {businessId:'business',branchId:'main',businessName:'Daily Supermarket',branchName:'Main Branch',ownerUserId:'owner'};
beforeEach(async () => {
  localStorage.clear(); setCloudConnectionIssue(null); await resetLocalDatabaseForTests(); await initializeStore();
  await addUser({username:'admin',name:'Admin',role:'admin',password:'synthetic-admin-pass'},true);
  await login('admin','synthetic-admin-pass');
  await addUser({username:'cashier',name:'Cashier',role:'cashier',password:'synthetic-cashier-pass'});
  await setInventoryAssociation(association);
  await addInventoryEntry({productId:'',productName:'Coffee',barcode:'coffee',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-09T10:00:00Z'});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setCloudConnectionIssue(null); });
it('restores the same branch after store reopen and cashier login without moving any branch data', async () => {
  const before = getLocalState();
  const signOut = vi.spyOn(supabaseClient!.auth,'signOut');
  await logout(); await initializeStore(); await login('cashier','synthetic-cashier-pass');
  expect(signOut).not.toHaveBeenCalled();
  expect(getInventoryAssociation()).toEqual(association);
  expect(getLocalState().branches).toEqual(before.branches);
  expect(getLocalState().outbox).toEqual(before.outbox);
  expect(getLocalState().branches.unassigned.products).toEqual([]);
  expect(getProducts()).toHaveLength(1);
  const p=getProducts()[0];
  const sale=await addSale({items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,salePrice:p.salePrice,purchasePrice:p.purchasePrice,currency:'USD'}],subtotal:4,total:4,currency:'USD',exchangeRate:89500,cashierName:'Cashier',date:'2026-10-09T10:01:00Z',refunded:false},'cashier-sale');
  expect(getProducts()[0].stockQuantity).toBe(8);expect(getSales()).toHaveLength(1);
  await addPartialRefund(sale.id,[{...sale.items[0],quantity:1}],'Cashier','cashier-refund');
  expect(getProducts()[0].stockQuantity).toBe(9);expect(getRefunds()).toHaveLength(1);
  expect(getLocalState().outbox.every(op=>op.businessId===association.businessId&&op.branchId===association.branchId)).toBe(true);
  await logout();await initializeStore();await login('cashier','synthetic-cashier-pass');
  expect(getInventoryAssociation()).toEqual(association);expect(getSales()).toHaveLength(1);expect(getRefunds()).toHaveLength(1);
});
it('cashiers cannot change the association, connect, or disconnect the device owner', async () => {
  await login('cashier','synthetic-cashier-pass');const before=getLocalState();
  const signIn=vi.spyOn(supabaseClient!.auth,'signInWithPassword');const signOut=vi.spyOn(supabaseClient!.auth,'signOut');
  await expect(setInventoryAssociation({...association,branchName:'Changed by cashier'})).rejects.toThrow('Administrator authorization');
  await expect(signInSupabaseOwner('synthetic@example.invalid','synthetic-password')).rejects.toThrow('Administrator authorization');
  await expect(signOutSupabaseOwner()).rejects.toThrow('Administrator authorization');
  expect(signIn).not.toHaveBeenCalled();expect(signOut).not.toHaveBeenCalled();expect(getLocalState()).toEqual(before);
});
it('expired owner auth retains branch and records, requires an administrator, and sends no cloud mutation', async () => {
  await localTransaction(state=>{state.outbox=[];}); // Disposable fixture only.
  vi.stubEnv('VITE_POS_SYNC_ENABLED','true');await login('cashier','synthetic-cashier-pass');
  vi.spyOn(supabaseClient!.auth,'getUser').mockResolvedValue({data:{user:null},error:{message:'Session expired'}} as never);
  const rpc=vi.spyOn(supabaseClient!,'rpc');const before=getLocalState();
  await expect(loadInventoryFromSupabase()).rejects.toThrow('administrator');
  expect(getCloudConnectionIssue()).toMatch(/administrator.*Settings/i);
  expect(getLocalState()).toEqual(before);expect(rpc).not.toHaveBeenCalled();
});
