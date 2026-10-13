import {CommitUncertainError,getLocalState,localTransaction,stableJson,originalRecoveryPending} from './localDatabase';
import {requireOperator} from './localAuth';
export interface PendingRequest {id:string;payload:unknown;heldSaleId?:string}
function validate(value:unknown): asserts value is PendingRequest {
  if(!value || typeof value!=='object' || typeof (value as PendingRequest).id!=='string' || !(value as PendingRequest).id || !('payload' in value))
    throw new Error('Saved request is damaged. Preserve storage and review before continuing.');
}
// Native state is SQLite-backed; browsers use atomic IndexedDB. Legacy keys
// remain untouched as evidence. Null tombstones prevent their resurrection.
export function readPendingRequest<T>(key:string):T|null {
  const saved=getLocalState().pendingRequests;
  if(saved && Object.prototype.hasOwnProperty.call(saved,key)) {
    const value=saved[key];if(value!==null)validate(value);return value as T|null;
  }
  const raw=globalThis.localStorage?.getItem(key);if(!raw)return null;
  const value:unknown=JSON.parse(raw);validate(value);return value as T;
}
export async function savePendingRequest(key:string,value:PendingRequest) {
  validate(value);
  await localTransaction(state=>{
    requireOperator(state);state.pendingRequests??={};
    if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending)throw new Error('Connection is saved separately. Checkout and refund preparation are paused pending reviewed branch attribution.');
    const existing=state.pendingRequests[key];
    if(existing && stableJson(existing)!==stableJson(value))throw new Error('Another saved operation needs confirmation. Retry its original transaction first.');
    state.pendingRequests[key]=structuredClone(value);
  });
}
export async function completePendingRequest(key:string,id:string) {
  await localTransaction(state=>{
    requireOperator(state);
    const existing=state.pendingRequests?.[key];
    if(existing && existing.id!==id)throw new Error('Saved transaction changed. Preserve it and review before continuing.');
    state.pendingRequests??={};state.pendingRequests[key]=null;
  });
}
export const isUncertainCommit=(error:unknown):boolean=>Boolean((error as {uncertainCommit?:boolean})?.uncertainCommit);
export async function executePendingRequest<T extends PendingRequest,R>(key:string,request:T,apply:(request:T)=>Promise<R>):Promise<R> {
  // No stock or financial effect can start until its retry ID is durable.
  await savePendingRequest(key,request);
  let result:R;
  try {result=await apply(request);}
  catch(error) {
    if(!isUncertainCommit(error)) {
      try {await completePendingRequest(key,request.id);}catch {throw new CommitUncertainError();}
    }
    throw error;
  }
  // Lost cleanup acknowledgement must retain the ID of the committed sale.
  try {await completePendingRequest(key,request.id);}catch {throw new CommitUncertainError();}
  return result;
}
