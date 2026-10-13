import { beforeEach, expect, it } from 'vitest';
import { initializeStore, addInventoryEntry, getProducts } from './store';
import { addUser, deleteUser, getCurrentUser, getUsers, login, needsAdministratorSetup } from './localAuth';
import { getLocalState, localTransaction, resetLocalDatabaseForTests } from './localDatabase';
import { isUnsafeClientKey } from './supabase';
import { getInventoryAssociation, setInventoryAssociation } from './inventorySync';
beforeEach(async () => { localStorage.clear(); await resetLocalDatabaseForTests(); await initializeStore(); });
it('does not seed public default passwords or trust persisted sessions', async () => {
  localStorage.setItem('pos_current_user', JSON.stringify({ role: 'admin', id: '1' }));
  expect(getCurrentUser()).toBeNull();
  expect(await login('admin', 'admin123')).toBeNull();
  expect(needsAdministratorSetup()).toBe(true);
});
it('stores salted hashes, validates passwords and enforces store permissions', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  expect(JSON.stringify(getLocalState())).not.toContain('correct-horse-battery');
  expect(getUsers()[0]).not.toHaveProperty('password');
  expect(await login('admin', 'wrong')).toBeNull();
  await expect(addInventoryEntry({ productId: '', productName: 'Coffee', barcode: 'coffee', quantityAdded: 1, purchasePrice: 1, salePrice: 2, salesmanName: 'Sam', date: '2026-09-30' })).rejects.toThrow('authorization');
  await login('admin', 'correct-horse-battery');
  await addUser({ username: 'cashier', name: 'Cashier', role: 'cashier', password: 'cashier-password-new' });
  await expect(addUser({ username: 'ADMIN', name: 'Duplicate', role: 'admin', password: 'another-password' })).rejects.toThrow('already in use');
  await expect(deleteUser(getUsers()[0].id)).rejects.toThrow('last administrator');
  await login('cashier', 'cashier-password-new');
  await expect(addUser({ username: 'rogue', name: 'Rogue', role: 'admin', password: 'another-password' })).rejects.toThrow('authorization');
}, 20000);
it('invalidates a session when its stored role is modified', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  await localTransaction(state => { state.users![0].user.role = 'cashier'; });
  expect(getCurrentUser()).toBeNull();
});
it('keeps an admin authorized when SQLite reorders credential keys before branch save', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  await localTransaction(state => {
    state.users = state.users?.map(({ user, salt, hash, iterations, native }) =>
      ({ hash, iterations, native, salt, user }));
  });
  expect(getCurrentUser()?.role).toBe('admin');
  await setInventoryAssociation({ businessId: 'business-1', branchId: 'branch-1', businessName: 'Daily Supermarket', branchName: 'Main Branch', ownerUserId: 'owner-1' });
  expect(getInventoryAssociation()?.branchId).toBe('branch-1');
});
it('does not allow a cashier to save the business and branch', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  await addUser({ username: 'cashier', name: 'Cashier', role: 'cashier', password: 'cashier-password-new' });
  await login('cashier', 'cashier-password-new');
  await expect(setInventoryAssociation({ businessId: 'business-1', branchId: 'branch-1', businessName: 'Daily Supermarket', branchName: 'Main Branch', ownerUserId: 'owner-1' })).rejects.toThrow('Administrator authorization');
  expect(getInventoryAssociation()).toBeNull();
}, 20000);
it('shows original customer inventory under retained branch IDs without moving or changing records', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  await localTransaction(state => {
    state.project1Settings = { business_id: 'business-1', branch_id: 'branch-1' };
    state.branches.unassigned.products.push({ id: 'original-product', barcode: 'original-barcode', name: 'Original', stockQuantity: 17, purchasePrice: 2, salePrice: 4 });
  });
  await setInventoryAssociation({ businessId: 'business-1', branchId: 'branch-1', businessName: 'Daily Supermarket', branchName: 'Main Branch', ownerUserId: 'owner-1' });
  expect(getInventoryAssociation()?.branchId).toBe('branch-1');
  expect(getLocalState().branches.unassigned.products).toHaveLength(1);
  expect(getLocalState().branches['business-1/branch-1'].products).toEqual([]);
  expect(getProducts()).toEqual(getLocalState().branches.unassigned.products);
}, 20000);
it('rejects service-role and secret keys while allowing publishable client keys', () => {
  expect(isUnsafeClientKey('sb_secret_test')).toBe(true);
  expect(isUnsafeClientKey('sb_publishable_test')).toBe(false);
  expect(isUnsafeClientKey('header.' + btoa(JSON.stringify({ role: 'service_role' })) + '.signature')).toBe(true);
  expect(isUnsafeClientKey('header.' + btoa(JSON.stringify({ role: 'anon' })) + '.signature')).toBe(false);
});

it('blocks new inventory writes in an already split original installation without changing either bucket', async () => {
  await addUser({ username: 'admin', name: 'Admin', role: 'admin', password: 'correct-horse-battery' }, true);
  await login('admin', 'correct-horse-battery');
  await setInventoryAssociation({ businessId: 'business-1', branchId: 'branch-1', businessName: 'Daily Supermarket', branchName: 'Main Branch', ownerUserId: 'owner-1' });
  await localTransaction(state => {
    state.project1Settings = { business_id: 'business-1', branch_id: 'branch-1' };
    state.branches.unassigned.products.push({ id: 'original-product', barcode: 'original-barcode', name: 'Original', stockQuantity: 17, purchasePrice: 2, salePrice: 4 });
  });
  const before = getLocalState();
  await expect(addInventoryEntry({ productId: '', productName: 'New', barcode: 'new', quantityAdded: 1, purchasePrice: 2, salePrice: 4, salesmanName: '', date: '2026-10-05' })).rejects.toThrow('paused until current inventory ownership is verified');
  expect(getLocalState()).toEqual(before);
});
