import {readAllPages} from './pagination';
import { validateBranchData } from './dataValidation';
import { validateCloudInventoryEntries, validateNewInventoryOperation } from './cloudReceiptIdentity';
import type { InventoryEntry, Product, Sale, Refund } from '@/types/pos';
import { getLocalState, localTransaction, emptyBranch, stableJson, originalRecoveryPending, reloadLocalState, CommitUncertainError, type LocalState } from './localDatabase';
import { associationSchema } from './dataValidation';
import { requireOperator, getCurrentUser } from './localAuth';
import { supabaseClient } from './supabase';
import {toast} from './notifications';
import { mergeCloudFinancialHistory } from './cloudFinancialHistory';
import { errorMessage } from './errorMessage';
import { setCloudConnectionIssue, ownerReconnectRequired } from './cloudConnectionStatus';

export function isHistoricalInventoryOperation(operation: {operationId:string}, state = getLocalState()): boolean {
  const saved=state.outbox.find(item=>item.operationId===operation.operationId);
  return state.inventoryActivation?.historicalOperationIds.includes(operation.operationId) === true || Boolean(saved && saved.protocolRevision!==3);
}

const ASSOCIATION_KEY = 'pos_supabase_branch_association';
const OUTBOX_KEY = 'pos_inventory_sync_outbox';

export interface BusinessBranchOption {
  id: string;
  name: string;
  branches: { id: string; name: string }[];
}

export interface InventoryAssociation {
  businessId: string;
  branchId: string;
  businessName: string;
  branchName: string;
  ownerUserId: string;
}

interface OperationScope {
  operationId: string;
  businessId: string | null;
  branchId: string | null;
  wirePayload?: string;
  blocked?: boolean;
  quarantined?: string;
  protocolRevision?: number;
  createdAt?: string;
  attempts?: number;
  lastError?: string;
  retryAt?: number;
}

export interface SaleOperation extends OperationScope { type: 'sale'; sale: Sale }
export interface RefundOperation extends OperationScope { type: 'refund'; refund: Refund; originalSale: Sale }
export interface RefundBatchOperation extends OperationScope { type: 'refund_batch'; refunds: Refund[]; originalSales: Sale[] }

export interface ReceiveOperation extends OperationScope {
  type: 'receive';
  entry: InventoryEntry;
  product: Product;
}

export interface InventoryEntryUpdateOperation extends OperationScope {
  type: 'inventory_entry_update';
  entryId: string;
  updates: Partial<InventoryEntry>;
}

export interface InventoryEntryDeleteOperation extends OperationScope {
  type: 'inventory_entry_delete';
  entryId: string;
}

export interface ProductUpsertOperation extends OperationScope {
  type: 'product_upsert';
  product: Product;
}

export interface ProductAdjustOperation extends OperationScope { type: 'product_adjust'; productId: string; quantityDelta: number; updates: Partial<Product> }

export interface ProductUpdateOperation extends OperationScope {
  type: 'product_update';
  productId: string;
  updates: Partial<Product>;
}

export interface StockDeltaOperation extends OperationScope {
  type: 'stock_delta';
  productId: string;
  quantityDelta: number;
}

export interface ProductDeleteOperation extends OperationScope {
  type: 'product_delete';
  productId: string;
}

export type InventorySyncOperation =
  | SaleOperation
  | RefundOperation
  | RefundBatchOperation
  | ReceiveOperation
  | InventoryEntryUpdateOperation
  | InventoryEntryDeleteOperation
  | ProductUpsertOperation
  | ProductAdjustOperation
  | ProductUpdateOperation
  | StockDeltaOperation
  | ProductDeleteOperation;

export type InventorySyncOperationInput =
  | Omit<SaleOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<RefundOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<RefundBatchOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<ReceiveOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<InventoryEntryUpdateOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<InventoryEntryDeleteOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<ProductUpsertOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<ProductAdjustOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<ProductUpdateOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<StockDeltaOperation, 'operationId' | 'businessId' | 'branchId'>
  | Omit<ProductDeleteOperation, 'operationId' | 'businessId' | 'branchId'>;

export const createOperationId = (): string => crypto.randomUUID();
export function getInventoryAssociation(): InventoryAssociation | null { return getLocalState().association; }
export function getPendingInventoryOperations(): InventorySyncOperation[] { return getLocalState().outbox; }
export function getPendingInventoryOperationCount(): number { return getPendingInventoryOperations().length; }
export async function setInventoryAssociation(association: InventoryAssociation): Promise<void> {
  associationSchema.parse(association);
  const committedRevision = await localTransaction(state => {
    requireOperator(state, true);
    if (state.outbox.some(operation => !isHistoricalInventoryOperation(operation,state) && operation.businessId && (operation.businessId !== association.businessId || operation.branchId !== association.branchId))) throw new Error('Resolve current branch operations before switching branches.');
    if (stableJson(state.association) !== stableJson(association) && Object.values(state.pendingRequests ?? {}).some(request => request !== null)) throw new Error('Confirm saved local transactions before switching branches; their original IDs are retained.');
    const nextKey = `${association.businessId}/${association.branchId}`;
    // Connection metadata is independent of historical ownership. Never move
    // buckets, bind queues or clear recovery markers as part of this save.
    state.association = structuredClone(association);
    state.branches[nextKey] ??= emptyBranch();
    return state.revision + 1;
  });
  // Re-read the durable store (SQLite on desktop), not the optimistic cache.
  let readback: LocalState;
  try { readback=await reloadLocalState(); } catch { throw new CommitUncertainError(); }
  if (readback.revision < committedRevision || stableJson(readback.association) !== stableJson(association)) throw new CommitUncertainError();
}
export async function bindUnassignedInventoryOperations(): Promise<number> {
  return localTransaction(state => {
    requireOperator(state, true);
    const association = state.association;
    if (!association) return 0;
    const unassigned = state.branches.unassigned;
    const key = `${association.businessId}/${association.branchId}`;
    if ((state.project1Settings || Object.keys(state.legacyStorageArchive ?? {}).length || unassigned?.sales.some(sale => sale.legacy)) && unassigned && (unassigned.products.length || unassigned.entries.length || unassigned.sales.length || unassigned.refunds.length)) {
      throw new Error('Preserved original customer records require reviewed branch recovery; automatic binding is prohibited.');
    }
    if (unassigned && (unassigned.products.length || unassigned.sales.length || unassigned.refunds.length || unassigned.entries.length)) {
      const target=state.branches[key];
      if (target && (target.products.length || target.sales.length || target.refunds.length || target.entries.length || Object.keys(target.completed).length)) throw new Error('Cannot combine offline inventory with an existing branch automatically.');
      state.branches[key] = unassigned;
      delete state.branches.unassigned;
    }
    let count = 0;
    state.outbox.forEach(operation => {
      if (!operation.businessId && !operation.branchId) { operation.businessId = association.businessId; operation.branchId = association.branchId; count++; }
    });
    return count;
  });
}
export function appendInventoryOperation(state: LocalState, operation: InventorySyncOperationInput, operationId = createOperationId()): string {
  if (originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending) throw new Error('Connection is saved separately. Inventory synchronization operations are blocked pending reviewed branch attribution.');
  if (isHistoricalInventoryOperation({operationId},state)) throw new Error("Historical operation IDs are retained for review and cannot be reused.");
  const previous = state.outbox.find(item => item.operationId === operationId);
  const next = { ...structuredClone(operation), protocolRevision: 3, createdAt: previous?.createdAt ?? new Date().toISOString(), operationId, businessId: state.association?.businessId ?? null, branchId: state.association?.branchId ?? null } as InventorySyncOperation;
  if (previous) {
    if (stableJson(previous.wirePayload ? JSON.parse(previous.wirePayload) : wireOperation(previous)) !== stableJson(next)) throw new Error('Operation ID was already used with different data.');
    return operationId;
  }
  validateNewInventoryOperation(next);
  state.outbox.push(next);
  return operationId;
}
export async function enqueueInventoryOperation(operation: InventorySyncOperationInput, operationId = createOperationId()): Promise<string> {
  const result = await localTransaction(state => { requireOperator(state, true); return appendInventoryOperation(state, operation, operationId); });
  void syncPendingInventory().catch(console.error);
  return result;
}

export async function signInSupabaseOwner(email: string, password: string): Promise<BusinessBranchOption[]> {
  requireOperator(getLocalState(), true);
  if (!supabaseClient) throw new Error('Supabase is not configured for this installation.');
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  if (!data.user) throw new Error('Supabase did not return an authenticated user.');
  return getOwnerBusinessBranches(data.user.id);
}

export async function getCurrentOwnerBusinessBranches(): Promise<BusinessBranchOption[]> {
  requireOperator(getLocalState(), true);
  if (!supabaseClient) throw new Error('Supabase is not configured for this installation.');
  const { data, error } = await supabaseClient.auth.getUser();
  if (error) { setCloudConnectionIssue(ownerReconnectRequired); throw error; }
  if (!data.user) { setCloudConnectionIssue(ownerReconnectRequired); return []; }
  setCloudConnectionIssue(null);
  return getOwnerBusinessBranches(data.user.id);
}

export async function getAuthenticatedOwnerUserId(): Promise<string | null> {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.getUser();
  if (error) { setCloudConnectionIssue(ownerReconnectRequired); throw error; }
  setCloudConnectionIssue(data.user ? null : ownerReconnectRequired);
  return data.user?.id ?? null;
}

async function getOwnerBusinessBranches(ownerUserId: string): Promise<BusinessBranchOption[]> {
  if (!supabaseClient) return [];
  const businesses = await readAllPages<{id:string;name:string}>(async after => {
    let query = supabaseClient!.from('businesses').select('id,name').eq('owner_id',ownerUserId).order('id').limit(500);
    if(after) query=query.gt('id',after);
    return await query;
  });

  const options: BusinessBranchOption[] = [];
  for (const business of businesses ?? []) {
    const branches = await readAllPages<{id:string;name:string}>(async after => {
      let query=supabaseClient!.from('branches').select('id,name').eq('business_id',business.id).order('id').limit(500);
      if(after) query=query.gt('id',after);
      return await query;
    });
    options.push({
      id: business.id,
      name: business.name,
      branches: (branches ?? []).map(branch => ({ id: branch.id, name: branch.name })),
    });
  }
  return options;
}

export async function signOutSupabaseOwner(): Promise<void> {
  requireOperator(getLocalState(), true);
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signOut({ scope: 'local' });
  if (error) throw error;
  setCloudConnectionIssue(ownerReconnectRequired);
}

export function cloudSynchronizationEnabled(): boolean {
  return import.meta.env.VITE_POS_SYNC_ENABLED === 'true';
}
// New clients only use the reviewed v2 API. Never fall back to unsafe legacy RPCs.
export async function verifySyncProtocol(): Promise<void> {
  if (!supabaseClient) throw new Error('Supabase is not configured.');
  const { data, error } = await supabaseClient.rpc('pos_sync_protocol');
  if (error || data?.version !== 2 || data?.revision !== 3 || data?.atomic_refund_batches !== true || data?.atomic_product_adjustments !== true || data?.archived_refund_catalog !== true || data?.ledger_preserved !== true) {
    throw new Error('Cloud sync paused: the reviewed v2 migration and ledger verification are required. Local operations remain safe and queued.');
  }
}
function wireOperation(operation: InventorySyncOperation) {
  const { attempts: _attempts, lastError: _error, retryAt: _retry, wirePayload: _wire, blocked: _blocked, quarantined: _quarantined, ...payload } = operation;
  return payload;
}
function replaceProductId(value: unknown, oldId: string, newId: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(item => replaceProductId(item, oldId, newId)); return; }
  const object = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(object)) {
    if ((key === 'productId' || (key === 'id' && 'stockQuantity' in object)) && item === oldId) object[key] = newId;
    else replaceProductId(item, oldId, newId);
  }
}
export function reconcileCanonicalProduct(state: LocalState, operation: InventorySyncOperation, oldId: string, newId: string) {
  if (!operation.businessId || !operation.branchId || oldId === newId) return;
  const branch = state.branches[`${operation.businessId}/${operation.branchId}`];
  if (!branch) throw new Error('Operation branch is missing.');
  const local = branch.products.find(product => product.id === oldId);
  const canonical = branch.products.find(product => product.id === newId);
  if (local && canonical) throw Object.assign(new Error('Canonical product conflict requires manual reconciliation; no stock was merged.'), { code: 'P0001' });
  branch.productAliases ??= {};
  Object.defineProperty(branch.productAliases, oldId, { value: newId, enumerable: true, writable: true, configurable: true });
  replaceProductId(branch, oldId, newId);
  state.outbox.filter(item => item.businessId === operation.businessId && item.branchId === operation.branchId).forEach(item => replaceProductId(item, oldId, newId));
  // wirePayload remains the original immutable request on uncertain retries.
}
function permanentSyncConflict(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && (code === 'P0001' || /^(22|23|42)[0-9A-Z]{3}$/.test(code) || code === 'PGRST202');
}
let activeSync: Promise<string[]> | null = null;
export function syncPendingInventory(): Promise<string[]> {
  if (activeSync) return activeSync;
  activeSync = syncPendingInventoryQueue().finally(() => { activeSync = null; });
  return activeSync;
}
async function syncPendingInventoryQueue(): Promise<string[]> {
  if (!cloudSynchronizationEnabled() || !supabaseClient || !navigator.onLine || !getCurrentUser()) return [];
  const association = getInventoryAssociation();
    if (!association || !getPendingInventoryOperationCount()) return [];
    if (originalRecoveryPending() || getLocalState().legacyBranchRecovery?.reconciliationPending) return []; // Never replay queues while customer recovery/reconciliation is pending.
  const confirmed: string[] = [];
  try {
    const { data, error } = await supabaseClient.auth.getUser();
    if (error || data.user?.id !== association.ownerUserId) {
      setCloudConnectionIssue(ownerReconnectRequired);
      throw new Error('Sign in to the associated owner account to sync.');
    }
    setCloudConnectionIssue(null);
    await verifySyncProtocol();
    while (true) {
      if (!getCurrentUser() || getInventoryAssociation()?.businessId !== association.businessId || getInventoryAssociation()?.branchId !== association.branchId) break;
      const candidate = getPendingInventoryOperations().find(operation => operation.businessId === association.businessId && operation.branchId === association.branchId && !isHistoricalInventoryOperation(operation));
      if (!candidate || candidate.quarantined || candidate.blocked || (candidate.retryAt ?? 0) > Date.now()) break;
      const operation = await localTransaction(state => {
        const current = state.outbox.find(item => item.operationId === candidate.operationId);
        if (!current) return null;
        current.wirePayload ??= stableJson(wireOperation(current));
        return structuredClone(current);
      });
      if (!operation) continue;
      try {
        const { data: result, error: rpcError } = await supabaseClient.rpc('pos_commit_operation', { p_operation: JSON.parse(operation.wirePayload!) });
        if (rpcError) throw rpcError;
        if (!result || result.operation_id !== operation.operationId || result.confirmed !== true) throw new Error('Cloud did not confirm this exact operation.');
        const mappings = result.product_ids;
        if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings) || Object.values(mappings).some(id => typeof id !== 'string' || !id)) throw new Error('Cloud returned incomplete canonical product confirmation.');
        const expectedIds = operation.type === 'receive' || operation.type === 'product_upsert' ? [operation.product.id] : operation.type === 'sale' ? operation.sale.items.map(item => item.productId) : operation.type === 'refund' ? operation.refund.items.map(item => item.productId) : operation.type === 'refund_batch' ? operation.refunds.flatMap(refund => refund.items.map(item => item.productId)) : [];
        if (expectedIds.some(id => !Object.prototype.hasOwnProperty.call(mappings,id))) throw new Error('Cloud omitted required canonical product confirmation.');
        await localTransaction(state => {
          for (const [oldId, newId] of Object.entries(mappings)) {
            if (typeof newId !== 'string') throw new Error('Invalid canonical product ID.');
            reconcileCanonicalProduct(state, operation, oldId, newId);
          }
          state.outbox = state.outbox.filter(item => item.operationId !== operation.operationId);
          state.recovery = state.recovery.filter(message => !message.startsWith('Cloud sync paused:') && message !== 'Sign in to the associated owner account to sync.');
        });
        confirmed.push(operation.operationId);
      } catch (error) {
        await localTransaction(state => {
          const current = state.outbox.find(item => item.operationId === operation.operationId);
          if (current) {
            current.attempts = (current.attempts ?? 0) + 1;
            current.lastError = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error);
            current.blocked = permanentSyncConflict(error);
            current.retryAt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(current.attempts, 8));
          }
        });
        break; // Preserve dependency ordering; never skip a stock/financial conflict.
      }
    }
  } catch (error) {
    await localTransaction(state => {
      const message = error instanceof Error ? error.message : 'Cloud authentication or protocol verification failed.';
      if (!state.recovery.includes(message)) state.recovery.push(message);
    });
  }
  return confirmed;
}
export async function retryInventoryOperations(): Promise<string[]> {
  await localTransaction(state => { requireOperator(state, true); if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending)throw new Error('Connection is saved separately. Synchronization retry is paused pending reviewed branch attribution; original operation IDs are retained.'); state.outbox.filter(operation => operation.businessId === state.association?.businessId && operation.branchId === state.association?.branchId).filter(operation => !operation.quarantined && !isHistoricalInventoryOperation(operation,state)).forEach(operation => { operation.retryAt = 0; operation.blocked = false; }); });
  return syncPendingInventory();
}
export async function loadInventoryFromSupabase(): Promise<void> {
  if (!cloudSynchronizationEnabled() || !supabaseClient || !navigator.onLine || !getCurrentUser()) return;
  const association = getInventoryAssociation();
  if (!association) return;
  if (originalRecoveryPending()) throw new Error('Cloud refresh is paused pending verified current inventory ownership for this branch. Use inventory-only verification; historical sales stay unassigned and saving the connection is allowed.');
  if (getLocalState().legacyBranchRecovery?.reconciliationPending) throw new Error('Legacy branch records were preserved. Cloud synchronization remains paused until inventory and original pending operations are reconciled; historical sales will not be uploaded.');
  const { data, error } = await supabaseClient.auth.getUser();
  if (error || data.user?.id !== association.ownerUserId) {
    setCloudConnectionIssue(ownerReconnectRequired);
    throw new Error('The cloud session does not match the branch owner. ' + ownerReconnectRequired);
  }
  setCloudConnectionIssue(null);
  await verifySyncProtocol();
  await syncPendingInventory();
  const before = getLocalState();
  if (before.outbox.some(operation => operation.businessId === association.businessId && operation.branchId === association.branchId && !isHistoricalInventoryOperation(operation,before))) return;
  // Server returns a single consistent snapshot; paging happens inside the RPC.
  const { data: snapshot, error: snapshotError } = await supabaseClient.rpc('pos_branch_snapshot', { p_business_id: association.businessId, p_branch_id: association.branchId });
  if (snapshotError) throw snapshotError;
  if (!snapshot || !Array.isArray(snapshot.products) || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.sales) || !Array.isArray(snapshot.refunds)) throw new Error('Invalid or incomplete cloud snapshot.');
  const key = `${association.businessId}/${association.branchId}`;
  const preserved = before.branches[key];
  if (!preserved) throw new Error('Local branch is not initialized.');
  // RPC snapshots omit local migration provenance. Match original receipts
  // exactly in this branch, instead of trusting an incoming legacy flag.
  snapshot.entries = validateCloudInventoryEntries(snapshot.entries, preserved.entries);
  snapshot.sales = snapshot.sales.map((sale: Sale) => ({ ...sale, legacy: false }));
  snapshot.refunds = snapshot.refunds.map((refund: Refund) => ({ ...refund, legacy: false }));
  validateBranchData(snapshot);
  await localTransaction(state => {
    if (state.revision !== before.revision || state.association?.businessId !== association.businessId || state.association?.branchId !== association.branchId) return;
    const key = `${association.businessId}/${association.branchId}`;
    const branch = state.branches[key];
    if (!branch) throw new Error('Local branch is not initialized.');
    const remoteIds = new Set(snapshot.products.map((product: Product) => product.id));
    if (branch.products.some(product => !remoteIds.has(product.id))) {
      throw new Error('Cloud inventory omits preserved local products. Reconcile the branch baseline before refreshing; local inventory remains unchanged.');
    }
    const inventoryFields = (product: Product) => ({ id: product.id, name: product.name, barcode: product.barcode, stockQuantity: product.stockQuantity, purchasePrice: product.purchasePrice, salePrice: product.salePrice, isActive: product.isActive !== false });
    if (branch.products.some(product => product.legacy && stableJson(inventoryFields(product)) !== stableJson(inventoryFields(snapshot.products.find((remote: Product) => remote.id === product.id))))) {
      throw new Error('Cloud inventory differs from preserved original inventory. Reviewed baseline reconciliation is required; local inventory remains unchanged.');
    }
    // Append verified new records, but retain the exact original representation
    // of existing receipts. RPC line ordering is not a financial amendment.
    const sales = mergeCloudFinancialHistory('sale', snapshot.sales, branch.sales);
    const refunds = mergeCloudFinancialHistory('refund', snapshot.refunds, branch.refunds);
    branch.products = snapshot.products;
    branch.allowNegativeStock = snapshot.allowNegativeStock === true;
    const missingEntries = branch.entries.filter(entry => !snapshot.entries.some((remote: InventoryEntry) => remote.id === entry.id));
    if (missingEntries.some(entry => !entry.legacy)) throw new Error('Cloud snapshot omits committed local receipts. Local records remain unchanged pending reconciliation.');
    branch.entries = [...snapshot.entries, ...missingEntries];
    branch.sales = sales;
    branch.refunds = refunds;
  });
}
let initialized = false;
export async function refreshInventorySync():Promise<void> {
  try {await syncPendingInventory();await loadInventoryFromSupabase();}
  catch(error) {
    const message = `Cloud refresh paused: ${errorMessage(error, 'Cloud snapshot could not be refreshed. Local records remain unchanged.')}`;
    setCloudConnectionIssue(message);
    toast.error(message);
  }
}
export function initializeInventorySync(): void {
  if (!cloudSynchronizationEnabled() || initialized || typeof window === 'undefined' || import.meta.env.MODE === 'test') return;
  initialized = true;
  const refresh = () => { void refreshInventorySync(); };
  window.addEventListener('online', refresh);
  supabaseClient?.auth.onAuthStateChange((_event, session) => { if (session) window.setTimeout(refresh, 0); });
  window.setInterval(refresh, 30000);
  refresh();
}
