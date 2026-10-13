import { z } from 'zod';
import { emptyBranch, getLocalState, localTransaction, type LocalState, legacyArchiveKeys } from './localDatabase';
import { requireOperator } from './localAuth';
import { associationSchema, validateBranchData, validateOperations } from './dataValidation';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { InventoryAssociation } from './inventorySync';
import { reloadLocalState } from './localDatabase';
import {readPendingRequest} from './pendingRequest';
export interface NativeBackupReceipt { id: string; directory: string; database: string; sha256: string; stateSha256: string; stateRevision: number }
export async function exportNativeRecoveryBackup(): Promise<NativeBackupReceipt> {
  requireOperator(getLocalState(), true);
  if (!isTauri()) throw new Error('Verified SQLite export requires the installed desktop application; no backup file was created.');
  const requestKeys=Object.keys(localStorage).filter(key=>key.startsWith('pos_checkout_v3:')||key.startsWith('pos_pending_v3:'));
  const legacyStorage = Object.fromEntries([...legacyArchiveKeys,...requestKeys].flatMap(key => {
    const value = localStorage.getItem(key); return value === null ? [] : [[key, value]];
  }));
  const receipt = await invoke<NativeBackupReceipt>('export_sqlite_recovery', { legacyStorage });
  if (!receipt?.id || !receipt.database || !receipt.directory || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !/^[a-f0-9]{64}$/.test(receipt.stateSha256) || !Number.isInteger(receipt.stateRevision)) throw new Error('Native backup verification was incomplete; do not use this export for recovery.');
  return receipt;
}
export async function recoverLegacyBranch(association: InventoryAssociation, backup: NativeBackupReceipt, confirmation: string): Promise<void> {
  requireOperator(getLocalState(), true);
  if (!isTauri()) throw new Error('Transactional legacy recovery requires the installed desktop application.');
  associationSchema.parse(association);
  const keys=new Set([...Object.keys(getLocalState().pendingRequests??{}),...Object.keys(localStorage).filter(key=>key.startsWith('pos_checkout_v3:')||key.startsWith('pos_pending_v3:'))]);
  for(const key of keys)if(readPendingRequest(key))throw new Error('Unfinished local transactions require reviewed completion before changing their branch. Export a backup and preserve their original IDs.');
  const { getAuthenticatedOwnerUserId, getCurrentOwnerBusinessBranches } = await import('./inventorySync');
  const owner = await getAuthenticatedOwnerUserId();
  const options = await getCurrentOwnerBusinessBranches();
  if (owner !== association.ownerUserId || !options.some(b => b.id === association.businessId && b.name === association.businessName && b.branches.some(item => item.id === association.branchId && item.name === association.branchName))) throw new Error('The authenticated Supabase owner cannot authorize the selected existing business and branch.');
  if (confirmation !== `${association.businessName} / ${association.branchName}`) throw new Error('Type the exact business / branch name to confirm ownership of the preserved records.');
  await invoke('recover_legacy_branch', { association, backupId: backup.id, confirmation });
  await reloadLocalState();
}
const envelope = z.object({ format: z.literal('swift-till-backup-v2'), exportedAt: z.string(), data: z.object({ version: z.literal(2), syncRevision: z.literal(3).optional(), legacyBranchRecovery: z.object({backupId:z.string(),backupSHA256:z.string(),businessId:z.string(),branchId:z.string(),reconciliationPending:z.literal(true)}).optional(), project1Settings: z.record(z.string()).optional(), legacyStorageArchive: z.record(z.string()).refine(value => Object.keys(value).every(key => (legacyArchiveKeys as readonly string[]).includes(key))).optional(), association: z.unknown(), branches: z.record(z.unknown()), outbox: z.array(z.unknown()), recovery: z.array(z.string()) }) });
export function exportRecoveryBackup(): string {
  const state = getLocalState();
  requireOperator(state, true);
  const { users: _credentials, revision: _revision, ...data } = state;
  return JSON.stringify({ format: 'swift-till-backup-v2', exportedAt: new Date().toISOString(), data }, null, 2);
}
export async function restoreRecoveryBackup(raw: string) {
  const parsed = envelope.parse(JSON.parse(raw));
  const data = parsed.data as Omit<LocalState, 'revision' | 'users'>;
  // UI retry envelopes are included in the native SQLite snapshot. This
  // portable restore cannot safely rebind another installation's operators.
  const originalData=JSON.parse(raw).data;
  if(originalData.inventoryActivation) throw new Error("Inventory ownership proof requires complete SQLite restore and baseline verification; portable restore will not discard or transfer it.");
  if(originalData.pendingRequests && Object.values(originalData.pendingRequests).some(request=>request!==null)) throw new Error('Backup contains unfinished local transactions. Use the complete SQLite backup and reviewed recovery; portable restore will not discard or replay them.');
  associationSchema.parse(data.association);
  validateOperations(data.outbox);
  for (const branch of Object.values(data.branches)) validateBranchData(branch);
  const ids = new Set<string>();
  for (const operation of data.outbox) {
    if (!operation || typeof operation.operationId !== 'string' || !operation.operationId || ids.has(operation.operationId)) throw new Error('Invalid or duplicate backup operation IDs.');
    ids.add(operation.operationId);
    if (operation.wirePayload) {
      const wire = JSON.parse(operation.wirePayload);
      if (wire.operationId !== operation.operationId || wire.businessId !== operation.businessId || wire.branchId !== operation.branchId) throw new Error('Backup operation scope/payload conflict.');
    }
  }
  await localTransaction(state => {
    requireOperator(state, true);
    if (state.outbox.length || Object.values(state.branches).some(branch => branch.products.length || branch.sales.length || branch.refunds.length || branch.entries.length || branch.heldSales?.length)) throw new Error('Restore is allowed only into an empty installation. Existing inventory and sales will never be overwritten.');
    state.branches = structuredClone(data.branches);
    state.branches.unassigned ??= emptyBranch();
    state.association = data.association;
    state.project1Settings = structuredClone(data.project1Settings ?? {});
    state.legacyStorageArchive = structuredClone(data.legacyStorageArchive ?? {});
    if (data.legacyBranchRecovery) state.legacyBranchRecovery = structuredClone(data.legacyBranchRecovery);
    state.outbox = structuredClone(data.outbox);
    for (const operation of state.outbox) {
      operation.quarantined = 'Restored queue requires cutover and completion review; automatic replay is prohibited.';
      operation.blocked = true;
    }
    state.syncRevision = 3;
    state.recovery = [...data.recovery, 'Backup restored without regenerating or replaying any operation.'];
  });
}
