import { invoke, isTauri } from '@tauri-apps/api/core';
import { getLocalState, reloadLocalState, scopeKey, stableJson } from './localDatabase';
import { requireOperator } from './localAuth';
import { associationSchema, productSchema } from './dataValidation';
import { exportNativeRecoveryBackup, type NativeBackupReceipt } from './recovery';
import { getAuthenticatedOwnerUserId, getCurrentOwnerBusinessBranches, verifySyncProtocol } from './inventorySync';
import { supabaseClient } from './supabase';
import type { InventoryAssociation } from './inventorySync';
import type { Product } from '@/types/pos';

export interface LegacyInventoryPreview {
  sourceId:string; sourcePath:string; databaseName:string; sha256:string; fingerprint:string; integrity:'ok';
  productCount:number; activeProductCount:number; stockQuantitySum:number; salesCount:number; refundsCount:number;
  inventoryEntryCount:number; branchAssignments:string[]; taxColumns:string[]; products:Product[];
}
export interface LegacyInventoryDifference {id:string;barcode:string;issue:string;local?:Product;cloud?:Product}
function normalize(rows:unknown[]):Product[]{
  if(!Array.isArray(rows))throw new Error('Legacy product preview is invalid.');
  const seenIds=new Set<string>(),seenCodes=new Set<string>();
  return rows.map(row=>{
    const p=productSchema.parse(row);
    if(seenIds.has(p.id)||seenCodes.has(p.barcode))throw new Error('Legacy inventory contains duplicate product IDs or barcodes.');
    seenIds.add(p.id);seenCodes.add(p.barcode);
    return {id:p.id,name:p.name,barcode:p.barcode,stockQuantity:p.stockQuantity,purchasePrice:p.purchasePrice,salePrice:p.salePrice,isActive:p.isActive!==false};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}
export function inventoryBaselineDifferences(sourceProducts:unknown,cloudProducts:unknown):LegacyInventoryDifference[]{
  const source=normalize(sourceProducts as unknown[]),cloud=normalize(cloudProducts as unknown[]),localById=new Map(source.map(p=>[p.id,p])),cloudById=new Map(cloud.map(p=>[p.id,p]));
  const differences:LegacyInventoryDifference[]=[];
  for(const local of source){const remote=cloudById.get(local.id);if(!remote){differences.push({id:local.id,barcode:local.barcode,issue:'missing from selected cloud branch',local});continue;}if(stableJson(local)!==stableJson(remote))differences.push({id:local.id,barcode:local.barcode,issue:'identity, price, status, or stock differs',local,cloud:remote});}
  for(const remote of cloud)if(!localById.has(remote.id))differences.push({id:remote.id,barcode:remote.barcode,issue:'extra in selected cloud branch',cloud:remote});
  return differences;
}
export function legacyInventorySourceKey(source:Pick<LegacyInventoryPreview,'fingerprint'|'branchAssignments'|'taxColumns'>):string{
  return stableJson({fingerprint:source.fingerprint,branchAssignments:[...source.branchAssignments].map(scope=>scope.startsWith('unassigned')?'unassigned':scope).sort(),taxColumns:[...source.taxColumns].sort()});
}
export function compareLegacyInventoryToCloud(sourceProducts:unknown,cloudProducts:unknown):Product[]{
  const source=normalize(sourceProducts as unknown[]),differences=inventoryBaselineDifferences(source,cloudProducts);
  if(differences.length){const detail=differences.slice(0,20).map(d=>`${d.barcode} [${d.id}]: ${d.issue}${d.local&&d.cloud?` (local stock ${d.local.stockQuantity}, cloud stock ${d.cloud.stockQuantity})`:''}`).join('; ');throw new Error(`Opening inventory does not match the selected authorized cloud branch. Nothing changed. Review ${differences.length} difference(s): ${detail}${differences.length>20?`; and ${differences.length-20} more`:''}`);}
  return source;
}
export async function discoverLegacyInventory():Promise<LegacyInventoryPreview[]>{
  if(!isTauri())return [];
  return invoke<LegacyInventoryPreview[]>('discover_legacy_inventory');
}
export async function restoreLegacyInventoryToSelectedBranch(sourceId:string,confirmation:string):Promise<NativeBackupReceipt>{
  const before=getLocalState();requireOperator(before,true);
  if(!isTauri())throw new Error('Inventory restoration requires the installed POS and its native SQLite safeguards.');
  const association=associationSchema.parse(before.association) as InventoryAssociation|null;
  if(!association)throw new Error('Save the authorized business and branch first.');
  if(confirmation!==`${association.businessName} / ${association.branchName}`)throw new Error('Type the exact business / branch to confirm inventory ownership.');
  if(Object.values(before.pendingRequests??{}).some(request=>request!==null))throw new Error('Unfinished local transactions require review before inventory restoration.');
  const owner=await getAuthenticatedOwnerUserId();
  if(!owner||owner!==association.ownerUserId)throw new Error('Reconnect the authorized Supabase business owner before restoring branch inventory.');
  const businesses=await getCurrentOwnerBusinessBranches();
  if(!businesses.some(b=>b.id===association.businessId&&b.name===association.businessName&&b.branches.some(br=>br.id===association.branchId&&br.name===association.branchName)))throw new Error('The signed-in owner cannot authorize the selected existing business and branch.');
  await verifySyncProtocol();
  if(!supabaseClient)throw new Error('Supabase is not configured. Inventory remains local and unchanged.');
  const {data,error}=await supabaseClient.rpc('pos_branch_snapshot',{p_business_id:association.businessId,p_branch_id:association.branchId});
  if(error)throw error;
  const products=compareLegacyInventoryToCloud((await invoke<LegacyInventoryPreview[]>('discover_legacy_inventory')).find(source=>source.sourceId===sourceId)?.products,data?.products);
  if(typeof data.allowNegativeStock!=='boolean')throw new Error('Cloud stock policy is missing; inventory import stopped.');
  if(await getAuthenticatedOwnerUserId()!==owner)throw new Error('Owner session changed during inventory review.');
  if(getLocalState().revision!==before.revision||scopeKey(getLocalState().association)!==scopeKey(association))throw new Error('POS branch or data changed during review; restart the review.');
  // A consistent SQLite and approved WebView recovery-key backup is automatic.
  const backup=await exportNativeRecoveryBackup();
  if(await getAuthenticatedOwnerUserId()!==owner)throw new Error('Owner session changed after backup; no inventory was imported.');
  await invoke('import_legacy_inventory',{sourceId,association,backupId:backup.id,confirmation,cloudProducts:products,cloudAllowNegativeStock:data.allowNegativeStock});
  const saved=await reloadLocalState();
  const key=scopeKey(association),expected=normalize(products),actual=normalize(saved.branches[key]?.products??[]);
  if(stableJson(expected)!==stableJson(actual)||saved.inventoryActivation?.sourcePath===undefined||saved.inventoryActivation.businessId!==association.businessId||saved.inventoryActivation.branchId!==association.branchId||saved.branches.unassigned.sales.length!==before.branches.unassigned.sales.length||stableJson(saved.outbox)!==stableJson(before.outbox))throw new Error('Inventory import acknowledgement did not match saved state. Preserve both backups and inspect SQLite before retrying.');
  return backup;
}
