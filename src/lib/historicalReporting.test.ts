import {expect,it} from 'vitest';
import {historicalReport} from './historicalReporting';
import {movements} from './accounting';
import type {Sale,Refund} from '@/types/pos';
export const syntheticHistory=():Sale[]=>Array.from({length:22220},(_,i)=>({id:`old-${i}`,legacy:true,items:i%2?[]:[{productId:'',productName:'Original coffee',barcode:'201',quantity:1,salePrice:2,purchasePrice:1,currency:'USD'}],subtotal:2,total:i%2?179000:2,currency:i%2?'LBP':'USD',exchangeRate:89500,cashierName:'Original cashier',date:'2026-09-30T22:30:00Z',refunded:false}));
it('22,220 preserved sales retain stored amounts and separate currencies without entering verified revenue',()=>{
  const sales=syntheticHistory(),before=JSON.stringify(sales);
  const refunds:Refund[]=[{id:'old-return',legacy:true,saleId:'old-0',items:[],totalRefunded:2,currency:'USD',cashierName:'Original cashier',date:'2026-10-01T10:00:00Z'}];
  const result=historicalReport(sales,refunds,date=>date==='2026-10-01');
  expect(result.sales).toHaveLength(22220);expect(result.missingItems).toBe(11110);expect(result.refunds).toHaveLength(1);
  expect(result.totals).toEqual({USD:{gross:22220,refunds:2,net:22218},LBP:{gross:1988690000,refunds:0,net:1988690000}});
  expect(movements(sales,refunds,()=>true)).toMatchObject({totalRevenue:0,numSales:0,numRefunds:0});expect(JSON.stringify(sales)).toBe(before);
});
it('preserves Beirut date boundaries and search without inventing missing items',()=>{
  const sales=syntheticHistory();expect(historicalReport(sales,[],date=>date==='2026-09-30').sales).toEqual([]);
  expect(historicalReport(sales,[],()=>true,'Original coffee').sales).toHaveLength(11110);
  const missing=historicalReport([sales[1]],[],()=>true);expect(missing.totals.LBP.gross).toBe(179000);expect(missing.items).toEqual([]);
});
it('invalid dates, amounts or duplicate IDs fail visibly rather than giving zero',()=>{
  const [sale]=syntheticHistory();expect(()=>historicalReport([{...sale,date:'damaged'}],[],()=>true)).toThrow('dates');
  expect(()=>historicalReport([{...sale,total:NaN}],[],()=>true)).toThrow('amount');
  expect(()=>historicalReport([sale,sale],[],()=>true)).toThrow('Duplicate');
});
