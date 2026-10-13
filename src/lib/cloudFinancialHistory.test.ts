import { expect, it } from 'vitest';
import { mergeCloudFinancialHistory } from './cloudFinancialHistory';
import type { Sale, Refund } from '@/types/pos';

const sale: Sale = {
  id: 'sale', items: ['z', 'a'].map(productId => ({productId, productName: productId, barcode: productId, quantity: 1, salePrice: 4, purchasePrice: 2, currency: 'USD'})),
  subtotal: 8, total: 8, currency: 'USD', exchangeRate: 89500, cashierName: 'Cashier', date: '2026-10-09T12:00:00Z', refunded: false,
};
const refund: Refund = {id:'refund',saleId:'sale',items:sale.items,totalRefunded:8,currency:'USD',exchangeRate:89500,cashierName:'Cashier',date:sale.date};

it('retains the exact original sale and refund when RPC line order and absent/false provenance differ', () => {
  for (const [kind, record] of [['sale', sale], ['refund', refund]] as const) {
    const original = structuredClone(record);
    const remote = {...record,legacy:false,items:[...record.items].reverse()};
    expect(mergeCloudFinancialHistory(kind, [remote], [record])).toEqual([original]);
    expect(record).toEqual(original);
  }
});
it('preserves every legacy record including refunds with missing historical parents', () => {
  const historical = {...refund,saleId:'missing-historical-sale',legacy:true,items:[]};
  expect(mergeCloudFinancialHistory('refund', [], [historical])).toEqual([historical]);
});
it('appends a genuinely new verified record once while preserving existing receipt representation', () => {
  const incoming = {...sale,id:'new-sale',items:[...sale.items].reverse()};
  const merged = mergeCloudFinancialHistory('sale', [sale,incoming], [sale]);
  expect(merged[0]).toEqual(sale);expect(merged[1]).toEqual({...incoming,legacy:false});
  expect(mergeCloudFinancialHistory('sale', [sale,incoming], merged)).toEqual(merged);
});
it.each([
  {total:9}, {subtotal:9}, {exchangeRate:100000}, {cashierName:'Other'}, {date:'2026-10-09T13:00:00Z'},
  {refunded:true}, {items:[{...sale.items[0],quantity:2},sale.items[1]]},
  {items:[{...sale.items[0],productId:'different'},sale.items[1]]},
  {items:[{...sale.items[0],salePrice:5},sale.items[1]]},
])('rejects an actual financial conflict without editing local records: %j', change => {
  const before=structuredClone(sale);
  expect(()=>mergeCloudFinancialHistory('sale',[{...sale,...change}],[sale])).toThrow('differs from immutable');
  expect(sale).toEqual(before);
});
it('never removes a verified local sale or refund omitted by the cloud snapshot', () => {
  expect(()=>mergeCloudFinancialHistory('sale',[],[sale])).toThrow('omits committed local sale (sale)');
  expect(()=>mergeCloudFinancialHistory('refund',[],[refund])).toThrow('omits committed local refund (refund)');
});
it('cannot promote a preserved historical receipt through a verified-only snapshot', () => {
  expect(()=>mergeCloudFinancialHistory('sale',[sale],[{...sale,legacy:true}])).toThrow('conflicts with preserved legacy');
});
it('does not trust an incoming legacy flag to authorize new incomplete financial records', () => {
  expect(()=>mergeCloudFinancialHistory('sale',[{...sale,legacy:true,items:[]}],[])).toThrow('complete item lines');
});
it('rejects duplicate transaction IDs and duplicate product lines', () => {
  expect(()=>mergeCloudFinancialHistory('sale',[sale,sale],[])).toThrow('Duplicate cloud sale ID');
  expect(()=>mergeCloudFinancialHistory('sale',[{...sale,items:[sale.items[0],sale.items[0]]}],[])).toThrow('Duplicate cloud sale product');
});
