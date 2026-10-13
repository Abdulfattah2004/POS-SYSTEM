import {useState,useRef} from 'react';
import {createTransactionId} from '@/lib/store';
import {getSavedAssociation,scopeKey} from '@/lib/localDatabase';
import {getCurrentUser} from '@/lib/localAuth';
import {readPendingRequest,executePendingRequest,isUncertainCommit} from '@/lib/pendingRequest';
export function useDurableOperation<T,R>(kind:string,apply:(payload:T,id:string)=>Promise<R>) {
  const key=`pos_pending_v3:${kind}:${getCurrentUser()?.id}:${scopeKey(getSavedAssociation())}`;
  const [initial]=useState(()=>{try{return {request:readPendingRequest<{id:string;payload:T}>(key),error:''};}catch(error){return {request:null,error:String(error)};}});
  const [pending,setPending]=useState(initial.request);
  const inFlight=useRef<Promise<R>|null>(null);
  const execute=async (payload:T):Promise<R>=>{
    if(initial.error)throw new Error(initial.error);
    if(inFlight.current)return inFlight.current;
    const request=pending??{id:createTransactionId(),payload};
    setPending(request);
    const operation=executePendingRequest(key,request,saved=>apply(saved.payload,saved.id));
    inFlight.current=operation;
    try {const result=await operation;setPending(null);return result;}
    catch(error){if(!isUncertainCommit(error))setPending(null);throw error;}
    finally {inFlight.current=null;}
  };
  return {pending,execute,error:initial.error};
}
