import { z } from 'zod';
const money = z.number().finite().nonnegative();
const line = z.object({ productId:z.string().min(1),productName:z.string(),quantity:z.number().int().positive(),salePrice:money,purchasePrice:money });
const base = z.object({ id:z.string().min(1),items:z.array(line).min(1),currency:z.enum(['USD','LBP']),exchangeRate:z.number().finite().positive(),date:z.string().refine(x=>Number.isFinite(Date.parse(x))),cashierName:z.string() });
const sale = base.extend({total:money,subtotal:money});
const refund = base.extend({saleId:z.string().min(1),totalRefunded:money});
const scope = {business_id:z.string().min(1),branch_id:z.string().min(1)};
const snapshot = z.object({products:z.array(z.object({id:z.string(),business_id:z.string(),branch_id:z.string(),is_active:z.boolean(),stock:z.number().int()}).passthrough()),sales:z.array(z.object({...scope,record:sale})),refunds:z.array(z.object({...scope,record:refund})),historical:z.object({sales:z.array(z.record(z.string(),z.unknown())),sale_items:z.array(z.record(z.string(),z.unknown())),refunds:z.array(z.record(z.string(),z.unknown())),refund_items:z.array(z.record(z.string(),z.unknown()))})});
export interface FinancialEvent {id:string;original_id:string;kind:'sale'|'refund';business_id:string;branch_id:string;total:number;subtotal:number;cashier_name:string;date:string;currency:string;settlement_currency:string;settlement_amount:number}
export interface FinancialItem {id:string;sale_id:string;product_id:string;product_name:string;quantity:number;sale_price:number;purchase_price:number;cost:number;branch_id:string;business_id:string;date:string}
export function normalizeSnapshot(raw:unknown,businessId:string,branchIds:string[]) {
 const data=snapshot.parse(raw); const allowed=new Set(branchIds);
 const inScope=(row:{business_id:string;branch_id:string})=>row.business_id===businessId&&allowed.has(row.branch_id);
 if([...data.products,...data.sales,...data.refunds].some(row=>!inScope(row))) throw new Error('Financial snapshot scope mismatch');
 const events:FinancialEvent[]=[]; const items:FinancialItem[]=[]; const seen=new Set<string>();
 for(const row of [...data.sales.map(row=>({...row,kind:'sale' as const})),...data.refunds.map(row=>({...row,kind:'refund' as const}))]) {
  const r=row.record;const kind=row.kind;const sign=kind==='sale'?1:-1;
  if(new Set(r.items.map(i=>i.productId)).size!==r.items.length)throw new Error('Duplicate financial item');
  const amount='total' in r?r.total:r.totalRefunded;
  const subtotal=Math.round(r.items.reduce((n,i)=>n+i.quantity*i.salePrice,0)*100)/100;
  const expected=r.currency==='USD'?subtotal:Math.round(subtotal*r.exchangeRate);
  if(Math.abs(amount-expected)>0.000001 || ('subtotal' in r&&Math.abs(r.subtotal-subtotal)>0.000001)) throw new Error('Financial snapshot total mismatch');
  const id=kind+':'+r.id;if(seen.has(id))throw new Error('Duplicate financial record');seen.add(id);
  // Item prices are immutable USD base prices. Rounded LBP settlement remains
  // visible separately; do not divide rounded cash amounts into false precision.
  events.push({id,original_id:r.id,kind,business_id:row.business_id,branch_id:row.branch_id,total:sign*subtotal,subtotal:sign*subtotal,cashier_name:r.cashierName,date:r.date,currency:'USD',settlement_currency:r.currency,settlement_amount:sign*amount});
  for(const i of r.items) items.push({id:id+':'+i.productId,sale_id:id,product_id:i.productId,product_name:i.productName,quantity:sign*i.quantity,sale_price:i.salePrice,purchase_price:i.purchasePrice,cost:i.purchasePrice,branch_id:row.branch_id,business_id:row.business_id,date:r.date});
 }
 const returned=new Map<string,number>();
 for(const r of data.refunds){const original=data.sales.find(s=>s.record.id===r.record.saleId);if(!original||original.branch_id!==r.branch_id)throw new Error('Refund parent missing from consistent snapshot');
  for(const item of r.record.items){const sold=original.record.items.find(i=>i.productId===item.productId);if(!sold||sold.salePrice!==item.salePrice||sold.purchasePrice!==item.purchasePrice)throw new Error('Refund item differs from immutable original sale');const key=JSON.stringify([r.record.saleId,item.productId]);const quantity=(returned.get(key)??0)+item.quantity;if(quantity>sold.quantity)throw new Error('Snapshot refund exceeds original sold quantity');returned.set(key,quantity);}
 }
 for(const rows of Object.values(data.historical))for(const row of rows){if((row.business_id!==undefined&&row.business_id!==businessId)||(row.branch_id!==undefined&&row.branch_id!==null&&!allowed.has(String(row.branch_id))))throw new Error('Historical snapshot scope mismatch');}

 return {sales:events.sort((a,b)=>b.date.localeCompare(a.date)),saleItems:items,products:data.products.filter(p=>p.is_active),historical:data.historical};
}
export function csvCell(value:unknown):string {const text=String(value??'');return '"'+(typeof value==='string'&&/^[\s]*[=+@-]/.test(text)?"'":'')+text.replaceAll('"','""')+'"';}
export function scopeBranches(allowed:string[],selected='all'):string[]{return selected==='all'?[...new Set(allowed)]:allowed.includes(selected)?[selected]:[];}

export async function readScopedSnapshot(request:(args:{p_business_id:string;p_branch_ids:string[]})=>PromiseLike<{data:unknown;error:{message?:string}|null}>,businessId:string,allowedBranchIds:string[],selectedBranch='all') {
 const ids=scopeBranches(allowedBranchIds,selectedBranch);
 if(!businessId||!ids.length)return normalizeSnapshot({products:[],sales:[],refunds:[],historical:{sales:[],sale_items:[],refunds:[],refund_items:[]}},businessId,[]);
 const {data,error}=await request({p_business_id:businessId,p_branch_ids:ids});
 if(error)throw new Error('Verified snapshot unavailable. '+(error.message??'Database request failed'));
 return normalizeSnapshot(data,businessId,ids);
}

export class SnapshotRequestGuard {
 private revision=0;
 private scope='';
 activate(scope:string){if(this.scope!==scope){this.scope=scope;this.revision++;}}
 begin(scope:string){return {revision:++this.revision,scope};}
 isCurrent(ticket:{revision:number;scope:string}){return ticket.revision===this.revision&&ticket.scope===this.scope;}
}
