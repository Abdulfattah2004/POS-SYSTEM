import {useMemo,useState} from 'react';
import type {Sale,Refund} from '@/types/pos';
import {businessDate,csv} from '@/lib/accounting';
import {historicalReport} from '@/lib/historicalReporting';
import {formatCurrency} from '@/lib/store';

export default function PreservedHistoryReport({sales,refunds,analytics}:{sales:Sale[];refunds:Refund[];analytics:boolean}) {
  const [period,setPeriod]=useState('all'),[from,setFrom]=useState(businessDate()),[to,setTo]=useState(businessDate()),[month,setMonth]=useState(businessDate().slice(0,7)),[query,setQuery]=useState(''),[page,setPage]=useState(0),[exportError,setExportError]=useState('');
  const result=useMemo(()=>{
    try {return {data:historicalReport(sales,refunds,day=>period==='all'||(period==='daily'?day===from:period==='monthly'?day.startsWith(month):day>=from&&day<=to),query),error:''};}
    catch(error){return {data:null,error:String(error)};}
  },[sales,refunds,period,from,to,month,query]);
  const report=result.data;
  const pages=Math.max(1,Math.ceil((report?.sales.length??0)/50)),current=Math.min(page,pages-1);
  const exportCSV=()=>{
    if(!report)return;
    try {
      const rows=[['Type','ID','Date','Currency','Stored Amount','Status'],...report.sales.map(sale=>['Sale',sale.id,sale.date,sale.currency,sale.total,'Historical / unverified']),...report.refunds.map(refund=>['Refund',refund.id,refund.date,refund.currency,refund.totalRefunded,'Historical / unverified'])];
      const url=URL.createObjectURL(new Blob([csv(rows)],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='preserved-local-history.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setExportError('');
    }catch(error){setExportError(`Export failed: ${String(error)}`);}
  };
  return <div className="p-6 space-y-4">
    <h2 className="pos-header">Preserved local history — unverified</h2>
    <p>Original stored settlement amounts, separated by currency. These are historical book totals, not verified cloud revenue. Missing item details and historical inconsistencies remain for review. No transactions are reassigned or replayed.</p>
    <div className="flex flex-wrap gap-3">
      <select aria-label="Historical period" className="pos-input" value={period} onChange={event=>{setPeriod(event.target.value);setPage(0);}}><option value="all">All preserved dates</option><option value="daily">Daily</option><option value="monthly">Monthly</option><option value="range">Date Range</option></select>
      {(period==='daily'||period==='range')&&<input aria-label="Historical date from" type="date" className="pos-input" value={from} onChange={event=>{setFrom(event.target.value);setPage(0);}}/>}
      {period==='range'&&<input aria-label="Historical date to" type="date" className="pos-input" value={to} onChange={event=>{setTo(event.target.value);setPage(0);}}/>}
      {period==='monthly'&&<input aria-label="Historical month" type="month" className="pos-input" value={month} onChange={event=>{setMonth(event.target.value);setPage(0);}}/>}
      <input aria-label="Search preserved history" className="pos-input" placeholder="Receipt, cashier, product or barcode" value={query} onChange={event=>{setQuery(event.target.value);setPage(0);}}/>
      <button className="pos-btn-secondary" disabled={!report} onClick={exportCSV}>Export historical CSV</button>
    </div>
    {result.error&&<p role="alert">Historical report unavailable: {result.error}</p>}{exportError&&<p role="alert">{exportError}</p>}
    {report&&<>
      <p>{report.sales.length.toLocaleString('en-US')} preserved sales · {report.refunds.length.toLocaleString('en-US')} preserved refunds · {report.missingItems.toLocaleString('en-US')} sales without item details · {report.unmatchedRefunds} refunds without a matching sale in this scope</p>
      {(['USD','LBP'] as const).map(currency=><div className="pos-card p-4" key={currency}><h3>{currency} historical book totals</h3><p>Stored gross sales: {formatCurrency(report.totals[currency].gross,currency)}</p><p>Stored refunds: {formatCurrency(report.totals[currency].refunds,currency)}</p><p>Stored net: {formatCurrency(report.totals[currency].net,currency)}</p></div>)}
      {analytics&&<div className="pos-card p-4"><h3>Available historical item details</h3><p>Sales lacking line items cannot contribute to product analytics. These figures describe only the preserved item details.</p>{report.items.map((item,index)=><p key={index}>{item.name}: {item.quantity} sold in available historical lines</p>)}</div>}
      <table className="w-full text-sm"><thead><tr><th>Original receipt</th><th>Original date</th><th>Stored total</th><th>Item details</th></tr></thead><tbody>{report.sales.slice(current*50,current*50+50).map(sale=><tr key={sale.id}><td>{sale.id}</td><td>{sale.date}</td><td>{formatCurrency(sale.total,sale.currency)}</td><td>{sale.items.length?`${sale.items.length} lines`:'Unavailable — review required'}</td></tr>)}</tbody></table>
      <div className="flex gap-3"><button className="pos-btn-secondary" disabled={current===0} onClick={()=>setPage(current-1)}>Previous historical page</button><span>Page {current+1} of {pages}</span><button className="pos-btn-secondary" disabled={current+1>=pages} onClick={()=>setPage(current+1)}>Next historical page</button></div>
    </>}
  </div>;
}
