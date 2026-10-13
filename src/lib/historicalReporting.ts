import type {Sale,Refund,Currency} from '@/types/pos';
import {businessDate} from './accounting';

// Read-only book totals: never certify legacy history or change cloud revenue.
export function historicalReport(sales:Sale[],refunds:Refund[],matches:(date:string)=>boolean,query='') {
  const dates=new Map<string,string>();
  const day=(value:string)=>{
    if(!dates.has(value)) {
      try {dates.set(value,businessDate(value));}catch {throw new Error('Historical dates could not be read. Preserve the original SQLite backup and review the affected records; totals are unavailable.');}
    }
    return dates.get(value)!;
  };
  const unique=(records:(Sale|Refund)[])=>{
    const ids=new Set<string>();for(const record of records){if(ids.has(record.id))throw new Error(`Duplicate historical transaction ID ${record.id}; totals require review.`);ids.add(record.id);}
  };
  unique(sales);unique(refunds);
  const search=query.trim().toLowerCase();
  const include=(record:Sale|Refund)=>matches(day(record.date)) && (!search || record.id.toLowerCase().includes(search) || record.cashierName.toLowerCase().includes(search) || record.items.some(item=>item.productName.toLowerCase().includes(search)||item.barcode.toLowerCase().includes(search)));
  const selectedSales=sales.filter(include),selectedRefunds=refunds.filter(include);
  const totals:Record<Currency,{gross:number;refunds:number;net:number}>={USD:{gross:0,refunds:0,net:0},LBP:{gross:0,refunds:0,net:0}};
  for(const [records,kind] of [[selectedSales,'gross'],[selectedRefunds,'refunds']] as const)for(const record of records){
    const amount='total' in record?record.total:record.totalRefunded;
    if(!Number.isFinite(amount)||amount<0||!totals[record.currency])throw new Error(`Historical amount or currency is invalid for ${record.id}; totals require review.`);
    totals[record.currency][kind]+=amount;
  }
  for(const total of Object.values(totals)){total.net=total.gross-total.refunds;if(![total.gross,total.refunds,total.net].every(Number.isFinite))throw new Error('Historical totals exceed the supported range; preserve records for review.');}
  const availableItems=new Map<string,{name:string;quantity:number;revenue:number}>();
  for(const sale of selectedSales)for(const item of sale.items){
    // A label is only a display grouping, never a fabricated product identity.
    const key=JSON.stringify([item.productId,item.barcode,item.productName]);
    const row=availableItems.get(key)??{name:item.productName,quantity:0,revenue:0};
    row.quantity+=item.quantity;row.revenue+=item.quantity*item.salePrice;availableItems.set(key,row);
  }
  const saleIds=new Set(sales.map(sale=>sale.id));
  return {sales:selectedSales,refunds:selectedRefunds,totals,missingItems:selectedSales.filter(sale=>!sale.items.length).length,unmatchedRefunds:selectedRefunds.filter(refund=>!saleIds.has(refund.saleId)).length,items:[...availableItems.values()].sort((a,b)=>b.quantity-a.quantity).slice(0,20)};
}
