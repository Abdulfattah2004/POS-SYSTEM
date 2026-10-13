import {invoke,isTauri} from '@tauri-apps/api/core';
import {productSchema} from './dataValidation';
import {getLocalState,reloadLocalState,stableJson,scopeKey,CommitUncertainError,type LocalState} from './localDatabase';
import {requireOperator} from './localAuth';
import {getAuthenticatedOwnerUserId,getCurrentOwnerBusinessBranches,verifySyncProtocol} from './inventorySync';
import {supabaseClient} from './supabase';
import type {NativeBackupReceipt} from './recovery';
import type {Product} from '@/types/pos';
import {readPendingRequest} from './pendingRequest';

// Names/barcodes never substitute for original product IDs. Every stock balance
// and price must match the authorized branch snapshot, not an inferred history.
export function verifyInventoryBaseline(state:LocalState,cloudProducts:unknown):Product[] {
  if(!Array.isArray(cloudProducts))throw new Error('Invalid cloud inventory baseline.');
  const normalize=(rows:unknown[])=>{
    const ids=new Set<string>(),barcodes=new Set<string>();
    return rows.map(raw=>{
      const p=productSchema.parse(raw);
      if(ids.has(p.id)||barcodes.has(p.barcode))throw new Error('Duplicate inventory identity requires reconciliation.');
      ids.add(p.id);barcodes.add(p.barcode);
      return {id:p.id,name:p.name,barcode:p.barcode,stockQuantity:p.stockQuantity,purchasePrice:p.purchasePrice,salePrice:p.salePrice,isActive:p.isActive!==false};
    }).sort((a,b)=>a.id.localeCompare(b.id));
  };
  const original=state.branches.unassigned?.products??[];
  if(!original.length)throw new Error('No unassigned current inventory requires activation.');
  if(stableJson(normalize(original))!==stableJson(normalize(cloudProducts)))throw new Error('Cloud product IDs, barcodes, prices or stock balances differ from current inventory. Review the exact baseline differences; nothing was activated or uploaded.');
  return cloudProducts.map(p=>productSchema.parse(p) as Product);
}
export async function activateVerifiedBranchInventory(backup:NativeBackupReceipt,confirmation:string):Promise<void> {
  const before=getLocalState();requireOperator(before,true);
  if(!isTauri())throw new Error('Verified inventory activation requires desktop SQLite and a verified backup.');
  const pendingKeys=new Set([...Object.keys(before.pendingRequests??{}),...Object.keys(localStorage).filter(key=>key.startsWith('pos_checkout_v3:')||key.startsWith('pos_pending_v3:'))]);
  for(const key of pendingKeys)if(readPendingRequest(key))throw new Error('Unfinished original transactions require review before inventory activation; preserve their original retry IDs.');
  const association=before.association;
  if(!association)throw new Error('Save the authorized business and branch first.');
  if(confirmation!==`${association.businessName} / ${association.branchName}`)throw new Error('Type the exact business / branch name to confirm current inventory ownership, not historical sales ownership.');
  if(!supabaseClient)throw new Error('Supabase is not configured.');
  const owner=await getAuthenticatedOwnerUserId();
  const options=await getCurrentOwnerBusinessBranches();
  if(owner!==association.ownerUserId || !options.some(b=>b.id===association.businessId && b.branches.some(branch=>branch.id===association.branchId)))throw new Error('The current Supabase owner cannot authorize this business and branch.');
  await verifySyncProtocol();
  const {data,error}=await supabaseClient.rpc('pos_branch_snapshot',{p_business_id:association.businessId,p_branch_id:association.branchId});
  if(error)throw error;
  const products=verifyInventoryBaseline(before,data?.products);
  if(typeof data.allowNegativeStock!=='boolean')throw new Error("Cloud stock policy is missing; inventory activation stopped.");
  if(await getAuthenticatedOwnerUserId()!==owner)throw new Error('Owner session changed during inventory verification.');
  const current=getLocalState();
  if(current.revision!==before.revision || stableJson(current.association)!==stableJson(association))throw new Error('POS state changed during inventory review; export a fresh backup and retry.');
  if(current.legacyBranchRecovery?.reconciliationPending)throw new Error('Previously recovered records require separate reconciliation.');
  const result=await invoke<LocalState>('activate_verified_inventory',{association,backupId:backup.id,confirmation,cloudProducts:products,cloudAllowNegativeStock:data.allowNegativeStock});
  const saved=await reloadLocalState();
  if(!result.inventoryActivation || result.inventoryActivation.backupId!==backup.id || saved.revision<result.revision || stableJson(saved.inventoryActivation)!==stableJson(result.inventoryActivation) || scopeKey(saved.association)!==scopeKey(association) || stableJson(saved.branches.unassigned)!==stableJson(before.branches.unassigned))throw new CommitUncertainError();
}
