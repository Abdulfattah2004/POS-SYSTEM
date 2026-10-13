// @vitest-environment node
// Opt-in, verified private COPY only. No live database or production requests.
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { initializeStore } from './store';
import { addUser, login } from './localAuth';
import { getLocalState, localTransaction, resetLocalDatabaseForTests, scopeKey, type BranchData } from './localDatabase';
import { loadInventoryFromSupabase, type InventoryAssociation } from './inventorySync';
import { validateBranchData } from './dataValidation';
import { supabaseClient } from './supabase';
const file = process.env.SWIFT_TILL_SYNC_REPAIR_FIXTURE;
const copied = file ? JSON.parse(readFileSync(file, 'utf8')) as { association: InventoryAssociation; branch: BranchData } : null;
const testCopy = it.skipIf(!copied);
const storage = new Map<string, string>();
function snapshot() {
  const source = structuredClone(copied!.branch);
  return { products: source.products.map(({ legacy: _legacy, ...product }) => product), entries: source.entries.slice().sort((a, b) => a.id.localeCompare(b.id)).map(({ legacy: _legacy, ...entry }) => entry), sales: source.sales.filter(sale => !sale.legacy), refunds: source.refunds.filter(refund => !refund.legacy), allowNegativeStock: true };
}
beforeEach(async () => {
  if (!copied) return;
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal('navigator', { onLine: true });vi.stubEnv('VITE_POS_SYNC_ENABLED', 'true');storage.clear();
  await resetLocalDatabaseForTests();await initializeStore();
  await addUser({ username: 'qa', name: 'Synthetic QA', role: 'admin', password: 'synthetic-copy-password' }, true);await login('qa', 'synthetic-copy-password');
  await localTransaction(state => { state.association = copied.association;state.branches = { [scopeKey(copied.association)]: structuredClone(copied.branch) };state.outbox = []; });
  vi.spyOn(supabaseClient!.auth, 'getUser').mockResolvedValue({ data: { user: { id: copied.association.ownerUserId } }, error: null } as never);
});
afterEach(() => { vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals(); });
testCopy('reproduces exactly the installed customer-copy paths 2 through 6 before applying the provenance repair', () => {
  const incoming = snapshot();
  try { validateBranchData(incoming);throw new Error('Expected original receipt validator to reject copied DTO'); }
  catch (error) { expect((error as { issues: { path: number[]; message: string }[] }).issues.filter(issue => issue.message === 'New receipts require product identity').map(issue => issue.path)).toEqual([[2], [3], [4], [5], [6]]); }
});
testCopy('cloud refresh on the current customer copy preserves all 19/15/76/15 records and stock 67', async () => {
  const before = getLocalState().branches[scopeKey(copied!.association)];
  vi.spyOn(supabaseClient!, 'rpc').mockImplementation(name => Promise.resolve({ data: name === 'pos_sync_protocol' ? { version: 2, revision: 3, atomic_refund_batches: true, atomic_product_adjustments: true, archived_refund_catalog: true, ledger_preserved: true } : snapshot(), error: null }) as never);
  await loadInventoryFromSupabase();
  const after = getLocalState().branches[scopeKey(copied!.association)];
  expect([after.products.length, after.entries.length, after.sales.length, after.refunds.length]).toEqual([19, 15, 76, 15]);
  expect(after.products.reduce((n, p) => n + p.stockQuantity, 0)).toBe(67);
  expect(after.entries).toEqual(before.entries.map(entry => entry.legacy ? entry : { ...entry, legacy: false }).sort((a, b) => a.id.localeCompare(b.id)));
  expect(after.products.map(({ legacy: _legacy, ...product }) => product)).toEqual(before.products.map(({ legacy: _legacy, ...product }) => product));
  expect(after.sales.filter(sale => sale.legacy)).toEqual(before.sales.filter(sale => sale.legacy));expect(after.refunds).toEqual(before.refunds);
  expect(getLocalState().outbox).toEqual([]);
  expect(supabaseClient!.rpc).not.toHaveBeenCalledWith('pos_commit_operation', expect.anything());
});
testCopy('an unknown identity-less remote receipt cannot use a legacy flag to overwrite the customer copy', async () => {
  const before = getLocalState().branches;
  const incoming = snapshot();incoming.entries.push({ ...incoming.entries[2], id: 'unverified-new-receipt', legacy: true } as never);
  vi.spyOn(supabaseClient!, 'rpc').mockImplementation(name => Promise.resolve({ data: name === 'pos_sync_protocol' ? { version: 2, revision: 3, atomic_refund_batches: true, atomic_product_adjustments: true, archived_refund_catalog: true, ledger_preserved: true } : incoming, error: null }) as never);
  await expect(loadInventoryFromSupabase()).rejects.toThrow('New receipts require product identity');expect(getLocalState().branches).toEqual(before);
});
