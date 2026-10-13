import { beforeEach, expect, it } from 'vitest';
import { addUser, login } from './localAuth';
import { initializeStore, addInventoryEntry, getProducts } from './store';
import { getLocalState, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { exportRecoveryBackup, restoreRecoveryBackup } from './recovery';
import {holdSale,getHeldSales} from './heldSales';
const setup = async () => {
  localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore();
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
};
beforeEach(setup);
it('exports and restores offline records with the same operation IDs, excluding credentials', async () => {
  await addInventoryEntry({ productId: '', productName: 'Coffee', barcode: 'coffee', quantityAdded: 3, purchasePrice: 1, salePrice: 2, salesmanName: 'Sam', date: '2026-09-30' }, 'stable-receipt');
  const backup = exportRecoveryBackup();
  expect(backup).not.toContain('correct-horse-battery');
  expect(backup).not.toContain('iterations');
  await setup();
  await restoreRecoveryBackup(backup);
  expect(getProducts()[0].stockQuantity).toBe(3);
  expect(getLocalState().outbox[0].operationId).toBe('stable-receipt');
  expect(getLocalState().outbox[0].quarantined).toContain('Restored');
  expect(getLocalState().outbox[0].blocked).toBe(true);
});
it('never overwrites existing stock/history during restore', async () => {
  const backup = exportRecoveryBackup();
  await addInventoryEntry({ productId: '', productName: 'Coffee', barcode: 'coffee', quantityAdded: 3, purchasePrice: 1, salePrice: 2, salesmanName: 'Sam', date: '2026-09-30' });
  await expect(restoreRecoveryBackup(backup)).rejects.toThrow('empty installation');
  expect(getProducts()[0].stockQuantity).toBe(3);
});
it('rejects malformed numeric data without committing it', async () => {
  const backup = JSON.parse(exportRecoveryBackup());
  backup.data.branches.unassigned.products.push({ id: 'bad', name: 'Bad', barcode: 'bad', stockQuantity: 0.5, purchasePrice: 1, salePrice: 1 });
  await expect(restoreRecoveryBackup(JSON.stringify(backup))).rejects.toThrow();
  expect(getProducts()).toEqual([]);
});

it('retains original business, branch and device settings through export and restore', async () => {
  const original = { business_id: 'original-business', branch_id: 'original-branch', exchange_rate: '100000', device_id: 'original-device' };
  await localTransaction(state => { state.project1Settings = original; });
  const backup = exportRecoveryBackup();
  await setup();
  await restoreRecoveryBackup(backup);
  expect(getLocalState().project1Settings).toEqual(original);
});

it('preserves held carts in backups without creating completed sales during restore',async()=>{
 const entry=await addInventoryEntry({productId:'',productName:'Held item',barcode:'hold-backup',quantityAdded:5,purchasePrice:1,salePrice:2,salesmanName:'Supplier',date:'2026-10-05'});
 await holdSale({label:'Retained hold',currency:'USD',items:[{productId:entry.productId,quantity:2}]},'retained-hold');
 const backup=exportRecoveryBackup();await setup();await restoreRecoveryBackup(backup);
 expect(getHeldSales()[0].id).toBe('retained-hold');expect(getProducts()[0].stockQuantity).toBe(5);expect(getLocalState().branches.unassigned.sales).toEqual([]);
});
it('preserves the pending legacy reconciliation lock in a JSON recovery copy',async()=>{
  const marker={backupId:'export-fixture',backupSHA256:'a'.repeat(64),businessId:'business',branchId:'main',reconciliationPending:true as const};
  await localTransaction(state=>{state.legacyBranchRecovery=marker;});
  const backup=exportRecoveryBackup();await setup();await restoreRecoveryBackup(backup);
  expect(getLocalState().legacyBranchRecovery).toEqual(marker);
});
