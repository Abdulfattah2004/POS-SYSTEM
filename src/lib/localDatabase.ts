import type { InventoryEntry, Product, Refund, Sale, HeldSale } from '@/types/pos';
import type { InventoryAssociation, InventorySyncOperation } from './inventorySync';
import type { Credential } from './localAuth';
import { associationSchema, validateBranchData, validateOperations } from './dataValidation';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { migrateLocalStorageToSqlite } from './migrateToSqlite';

export interface BranchData {
  heldSales?: HeldSale[];
  allowNegativeStock?: boolean;
  exchangeRate?: number;
  productAliases?: Record<string, string>;
  products: Product[];
  sales: Sale[];
  refunds: Refund[];
  entries: InventoryEntry[];
  completed: Record<string, { request: string; result: unknown }>;
}
export interface LocalState {
  version: 2;
  syncRevision?: 3;
  legacyStorageArchive?: Record<string, string>;
  revision: number;
  association: InventoryAssociation | null;
  branches: Record<string, BranchData>;
  outbox: InventorySyncOperation[];
  recovery: string[];
  users?: Credential[];
  project1Settings?: Record<string, string>;
  pendingRequests?: Record<string, {id:string;payload:unknown;heldSaleId?:string} | null>;
  inventoryActivation?: { businessId: string; branchId: string; backupId: string; backupSHA256: string; inventorySHA256: string; historicalOperationIds: string[]; sourceFingerprint?:string; sourcePath?:string; sourceDatabaseSHA256?:string; sourceProductCount?:number; sourceStockQuantitySum?:number; inventoryImport?:boolean };
  legacyBranchRecovery?: { backupId: string; backupSHA256: string; businessId: string; branchId: string; reconciliationPending: true };
}
const DB_NAME = 'swift-till-v2';
let connection: IDBDatabase | null = null;
let opening: Promise<IDBDatabase> | null = null;
let cached: LocalState | null = null;
export interface LegacyInventoryReadView {sourceId:string;sourcePath:string;fingerprint:string;branchAssignments:string[];taxColumns:string[];products:Product[];productCount:number;stockQuantitySum:number}
let legacyInventoryReadView:LegacyInventoryReadView|null=null;
let legacyInventoryDiscoveryError:string|null=null;
export function getLegacyInventoryReadView():LegacyInventoryReadView|null{return legacyInventoryReadView?structuredClone(legacyInventoryReadView):null}
export function getLegacyInventoryDiscoveryError():string|null{return legacyInventoryDiscoveryError}
const listeners = new Set<() => void>();
export class CommitUncertainError extends Error {
  readonly uncertainCommit = true;
  constructor() { super('Local commit confirmation was lost. Keep this request and retry it; do not enter it as a new transaction.'); }
}
// Test workers have separate fake IndexedDB instances and must not exchange
// notifications. Production windows share the real database and this channel.
const channel = import.meta.env.MODE !== 'test' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('swift-till-commits') : null;
channel?.addEventListener('message', () => { void reloadLocalState(); });

export const emptyBranch = (): BranchData => ({ allowNegativeStock: true, exchangeRate: 89500, products: [], sales: [], refunds: [], entries: [], completed: {} });
export const scopeKey = (association: InventoryAssociation | null) => association
  ? `${association.businessId}/${association.branchId}` : 'unassigned';
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
export function resolveLocalProductId(branch: BranchData, id: string): string {
  const seen = new Set<string>();
  while (branch.productAliases && Object.prototype.hasOwnProperty.call(branch.productAliases, id)) {
    if (seen.has(id)) throw new Error('Product identity mapping is damaged.');
    seen.add(id); id = branch.productAliases[id];
  }
  return id;
}
export function activeBranch(state = getLocalState()): BranchData {
  const key = scopeKey(state.association);
  return state.branches[key] ?? (state.branches[key] = emptyBranch());
}
// Read-only view of records whose retained original scope matches the selected
// branch. This never moves buckets, changes balances or regenerates operations.
export function originalBelongsToSelectedBranch(state = getLocalState()): boolean {
  return Boolean(state.association && state.project1Settings?.business_id === state.association.businessId && state.project1Settings?.branch_id === state.association.branchId);
}
export function inventoryOwnershipVerified(state = getLocalState()): boolean {
  const proof = state.inventoryActivation;
  return Boolean(proof && state.association && proof.businessId === state.association.businessId && proof.branchId === state.association.branchId);
}
// Financial history is protected independently. Only unattributed inventory,
// unfinished legacy carts, or an existing reviewed-recovery lock pauses trading.
export function originalRecoveryPending(state = getLocalState()): boolean {
  const original = state.branches.unassigned;
  return Boolean((state.association || state.inventoryActivation) && original && !inventoryOwnershipVerified(state) &&
    (original.products.length || original.entries.length || original.heldSales?.length));
}
export function visibleBranch(state = getLocalState()): BranchData {
  const selected = activeBranch(state);
  const original = state.branches.unassigned;
  if (!original || inventoryOwnershipVerified(state) || !originalBelongsToSelectedBranch(state)) return selected;
  const view = structuredClone(selected);
  for (const collection of ['products', 'entries', 'sales', 'refunds'] as const) {
    const known = new Map(selected[collection].map(record => [record.id, record] as const));
    for (const record of original[collection]) {
      const existing = known.get(record.id);
      if (existing && stableJson(existing) !== stableJson(record)) throw new Error('Original and branch records conflict. Preserve backups and review recovery before displaying combined inventory.');
    }
    // The only assignments are to a detached read view, never durable state.
    (view[collection] as {id:string}[]) = structuredClone([...original[collection].filter(record => !known.has(record.id)), ...selected[collection]]);
  }
  return view;
}
export function getLocalState(): LocalState {
  if (!cached) throw new Error('Local database is not ready.');
  return structuredClone(cached);
}
export function getLocalRevision(): number { return cached?.revision ?? -1; }
export function getSavedAssociation():InventoryAssociation|null {
  if(!cached)throw new Error('Local database is not ready.');return structuredClone(cached.association);
}
export function readLocalUsers():Credential[] {
  if(!cached)throw new Error('Local database is not ready.');return structuredClone(cached.users??[]);
}
export function readBranchPreferences() {
  if(!cached)throw new Error('Local database is not ready.');const branch=cached.branches[scopeKey(cached.association)];
  return {exchangeRate:branch?.exchangeRate??89500,allowNegativeStock:branch?.allowNegativeStock!==false};
}
export function readHeldSales():HeldSale[] {
  if(!cached)throw new Error('Local database is not ready.');return structuredClone(cached.branches[scopeKey(cached.association)]?.heldSales??[]);
}
// Scanning one barcode must not clone tens of thousands of unrelated sales,
// users and archived storage. Return detached records with the same scope rules.
export function readVisibleCollection<K extends 'products'|'sales'|'refunds'|'entries'>(field:K):BranchData[K] {
  if(!cached)throw new Error('Local database is not ready.');
  const selected=cached.branches[scopeKey(cached.association)]??emptyBranch();
  const original=cached.branches.unassigned;
  if(!original||inventoryOwnershipVerified(cached)||!originalBelongsToSelectedBranch(cached))return structuredClone(selected[field]);
  const known=new Map<string,{id:string}>(selected[field].map(record=>[record.id,record] as const));
  for(const record of original[field]){
    const existing=known.get(record.id);
    if(existing&&stableJson(existing)!==stableJson(record))throw new Error('Original and branch records conflict. Preserve backups and review recovery before displaying combined inventory.');
  }
  return structuredClone([...original[field].filter(record=>!known.has(record.id)),...selected[field]]) as BranchData[K];
}
export function subscribeLocalState(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(state: LocalState) {
  if (cached && state.revision < cached.revision) return;
  cached = state;
  listeners.forEach(listener => listener());
}
function openDatabase(): Promise<IDBDatabase> {
  if (connection) return Promise.resolve(connection);
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB is required for safe offline transactions.')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Close other POS windows to open the local database.'));
    request.onsuccess = () => {
      connection = request.result;
      connection.onversionchange = () => { connection?.close(); connection = null; opening = null; };
      resolve(connection);
    };
  });
  return opening;
}
export const legacyArchiveKeys = ['pos_products','pos_sales','pos_refunds','pos_inventory_entries','pos_inventory_sync_outbox','pos_supabase_branch_association','pos_exchange_rate'] as const;
function captureLegacyStorage(): Record<string,string> {
  return Object.fromEntries(legacyArchiveKeys.flatMap(key => { const value=localStorage.getItem(key); return value === null ? [] : [[key,value]]; }));
}
function legacyState(): LocalState {
  const recovery: string[] = [];
  function read<T>(key: string, fallback: T): T {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    try { return JSON.parse(raw); }
    catch { throw new Error(`Cannot migrate damaged ${key}. Original storage has been preserved.`); }
  }
  const association = read<InventoryAssociation | null>('pos_supabase_branch_association', null);
  const branch = emptyBranch();
  branch.exchangeRate = read('pos_exchange_rate', 89500);
  if (!Number.isFinite(branch.exchangeRate) || branch.exchangeRate! <= 0) throw new Error('Invalid legacy exchange rate; original data has been preserved.');
  branch.products = read('pos_products', []);
  branch.sales = read('pos_sales', []);
  branch.refunds = read('pos_refunds', []);
  branch.entries = read('pos_inventory_entries', []);
  for (const value of [branch.products, branch.sales, branch.refunds, branch.entries]) {
    if (!Array.isArray(value)) throw new Error('Invalid legacy dataset; migration stopped without changing it.');
  }
  // Preserve stored historical quantities, totals and flags exactly. Missing
  // original lines cannot be inferred safely from possibly incomplete refunds.
  for (const sale of branch.sales) sale.legacy = true;
  if (branch.sales.length) recovery.push('Legacy sales preserved locally. Cloud financial import requires ledger reconciliation; no stock movements were regenerated.');
  const outbox = read<InventorySyncOperation[]>('pos_inventory_sync_outbox', []);
  if (!Array.isArray(outbox)) throw new Error('Invalid legacy outbox; migration stopped.');
  validateBranchData(branch);
  validateOperations(outbox);
  associationSchema.parse(association);
  return { version: 2, revision: 0, association, branches: { [scopeKey(association)]: branch }, outbox, recovery };
}
export async function initializeLocalDatabase(): Promise<void> {
  if (isTauri()) {
    await migrateLocalStorageToSqlite();
    let state = await invoke<LocalState | null>('read_pos_state');
    if (!state) {
      const original = await invoke<BranchData & { settings: Record<string,string> }>('read_original_snapshot');
      const branch = { ...emptyBranch(), products: original.products.map(p => ({...p, legacy:true})), sales: original.sales, refunds: original.refunds, entries: original.entries, exchangeRate: Number(original.settings.exchange_rate ?? 89500) };
      const rawQueue = localStorage.getItem('pos_inventory_sync_outbox');
      const outbox: InventorySyncOperation[] = rawQueue ? JSON.parse(rawQueue) : [];
      validateOperations(outbox);
      for (const operation of outbox) { operation.quarantined = 'Original Project 1 queue requires historical reconciliation; automatic replay prohibited.'; operation.blocked = true; }
      state = { version: 2, syncRevision: 3, revision: 0, association: null, branches: { unassigned: branch }, outbox,
        project1Settings: original.settings, legacyStorageArchive: captureLegacyStorage(),
        recovery: ['Original SQLite records and configuration retained. Historical financial records require reconciliation before new refunds or cloud import.'] };
      if (Object.keys(original.settings).some(key => key === 'business_id' || key === 'branch_id')) state.recovery.push('Original business and branch IDs retained. An administrator must verify owner association before cloud use.');
      validateBranchData(branch);
      await invoke<boolean>('commit_pos_state', { expectedRevision: -1, document: state });
      state = await invoke<LocalState>('read_pos_state');
    }
    if (!state || state.version !== 2) throw new Error('Unsupported SQLite state; original data retained.');
    Object.values(state.branches).forEach(validateBranchData); validateOperations(state.outbox);
    publish(state);
    legacyInventoryReadView=null;
    legacyInventoryDiscoveryError=null;
    try{
      const sources=await invoke<LegacyInventoryReadView[]>('discover_legacy_inventory');
      const populated=Array.isArray(sources)?sources.filter(source=>source.productCount>0):[];
      const sourceKeys=populated.map(source=>JSON.stringify({fingerprint:source.fingerprint,branchAssignments:[...(source.branchAssignments??[])].map(scope=>scope.startsWith('unassigned')?'unassigned':scope).sort(),taxColumns:[...(source.taxColumns??[])].sort()}));
      if(populated.length&&new Set(sourceKeys).size===1)legacyInventoryReadView=populated[0];
      else if(populated.length>1)legacyInventoryDiscoveryError='Original POS database files contain different inventory. Open Settings and review every database; none was chosen automatically.';
    }catch(error){legacyInventoryDiscoveryError=error instanceof Error?error.message:'Original inventory discovery failed safely; the database files were not changed.';console.error('[legacy-inventory] read-only source discovery failed.',error);}
    return;
  }
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
    const store = tx.objectStore('state');
    const request = store.get('root');
    let result: LocalState;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        result = request.result ?? legacyState();
        if (result.version !== 2) throw new Error('Unsupported local database version.');
        Object.values(result.branches).forEach(validateBranchData);
        validateOperations(result.outbox);
        associationSchema.parse(result.association);
        if (result.syncRevision !== 3) {
          for (const operation of result.outbox) {
            operation.quarantined = 'Pre-cutover operation: completion is unknown. Review against backups; automatic replay is prohibited.';
            operation.blocked = true;
          }
          result.legacyStorageArchive ??= captureLegacyStorage();
          result.syncRevision = 3;
          if (result.outbox.length) result.recovery.push('Existing queue quarantined. No historical stock movements will be replayed.');
          store.put(result, 'root');
        } else if (!request.result) store.put(result, 'root');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => { publish(result); resolve(); };
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Local database initialization failed.'));
  });
}
export async function reloadLocalState(): Promise<LocalState> {
  if (isTauri()) {
    const state = await invoke<LocalState>('read_pos_state');
    if (!state) throw new Error('Durable local state is missing; retain the database and review before continuing.');
    publish(state);
    return structuredClone(state);
  }
  const db = await openDatabase();
  const tx = db.transaction('state', 'readonly');
  const request = tx.objectStore('state').get('root');
  return new Promise<LocalState>((resolve, reject) => {
    tx.oncomplete = () => { if (!request.result) { reject(new Error('Durable local state is missing.')); return; } publish(request.result); resolve(structuredClone(request.result)); };
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
// The mutation is synchronous: every read, validation and write occurs in one
// IndexedDB readwrite transaction. IndexedDB serializes these across windows.
export async function localTransaction<T>(mutate: (state: LocalState) => T): Promise<T> {
  if (isTauri()) {
    // Compare-and-swap is atomic in SQLite. A losing window recomputes against
    // committed state, including completed IDs, stock and refund remainders.
    for (let attempt = 0; attempt < 12; attempt++) {
      const state = await invoke<LocalState>('read_pos_state');
      if (!state) throw new Error('Initialize the local database first.');
      const expectedRevision = state.revision;
      const result = mutate(state);
      state.revision++;
      let committed: boolean;
      try { committed=await invoke<boolean>('commit_pos_state', { expectedRevision, document: state }); }
      catch (error) {
        let saved: LocalState;
        try { saved=await invoke<LocalState>('read_pos_state'); } catch { throw new CommitUncertainError(); }
        if (stableJson(saved)===stableJson(state)) { publish(saved); return result; }
        if (saved?.revision!==expectedRevision) throw new CommitUncertainError();
        throw error;
      }
      if (committed) {
        publish(state); channel?.postMessage(state.revision); return result;
      }
    }
    throw new Error('Another window is busy. Retry this same transaction.');
  }
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite', { durability: 'strict' });
    const store = tx.objectStore('state');
    const request = store.get('root');
    let state: LocalState;
    let result: T;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        state = request.result;
        if (!state) throw new Error('Initialize the local database first.');
        result = mutate(state);
        state.revision += 1;
        store.put(state, 'root');
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => { publish(state); channel?.postMessage(state.revision); resolve(result); };
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error('Transaction was not committed.'));
  });
}
export async function resetLocalDatabaseForTests() {
  if (import.meta.env.MODE !== 'test') throw new Error('Database reset is only permitted in isolated tests.');
  connection?.close(); connection = null; opening = null; cached = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  });
}
