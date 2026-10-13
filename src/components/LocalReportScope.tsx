import {useMemo,useState,useSyncExternalStore,type ReactNode} from 'react';
import {activeBranch,getLocalRevision,getLocalState,subscribeLocalState} from '@/lib/localDatabase';
import type {Sale,Refund} from '@/types/pos';
import HistoricalHistory from './PreservedHistoryReport';

export default function LocalReportScope({children,analytics=false}:{children:(sales:Sale[],refunds:Refund[])=>ReactNode;analytics?:boolean}) {
  const revision=useSyncExternalStore(subscribeLocalState,getLocalRevision,getLocalRevision);
  const [selected,setSelected]=useState('auto');
  const data=useMemo(()=>{
    try {
      if(revision<0)throw new Error('Local database is not ready.');
      const state=getLocalState();const branch=activeBranch(state);
      const sales=branch.sales.filter(sale=>!sale.legacy);
      const legacySales=branch.sales.filter(sale=>sale.legacy);
      const legacyIds=new Set(legacySales.map(sale=>sale.id));
      return {label:state.association?`${state.association.businessName} / ${state.association.branchName}`:'Unassigned local scope',sales,refunds:branch.refunds,legacySales,legacyRefunds:branch.refunds.filter(refund=>refund.legacy||legacyIds.has(refund.saleId)),unassigned:state.association?state.branches.unassigned:undefined,error:''};
    }catch(error){return {error:`Reports could not load local records: ${error instanceof Error?error.message:String(error)}`};}
  },[revision]);
  if(data.error || !data.sales)return <div role="alert" className="p-6">{data.error}</div>;
  const scope=selected==='auto'?(data.sales.length?'verified':data.legacySales!.length?'legacy':data.unassigned?.sales.length?'unassigned':'verified'):selected;
  const records=scope==='unassigned'?data.unassigned:scope==='legacy'?{sales:data.legacySales!,refunds:data.legacyRefunds!}:null;
  return <>
    <div className="m-6 mb-0 pos-card p-4">
      <label className="block">Reporting scope
        <select className="pos-input ml-3" aria-label="Reporting scope" value={scope} onChange={event=>setSelected(event.target.value)}>
          <option value="verified">{data.label} — verified transactions ({data.sales.length})</option>
          <option value="legacy">{data.label} — preserved historical records ({data.legacySales!.length})</option>
          {data.unassigned&&<option value="unassigned">Unassigned local history ({data.unassigned.sales.length})</option>}
        </select>
      </label>
      <p className="text-sm mt-2">Historical records remain separate from verified branch revenue. Changing this view never moves records or uploads historical transactions.</p>
    </div>
    {records?<HistoricalHistory key={scope} sales={records.sales} refunds={records.refunds} analytics={analytics}/>:children(data.sales,data.refunds!)}
  </>;
}
