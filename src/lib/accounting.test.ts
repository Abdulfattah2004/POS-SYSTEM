import { expect, it } from 'vitest';
import { businessDate, movements, csv } from './accounting';
import type { Sale, Refund } from '@/types/pos';
const items = [{ productId: 'coffee', productName: 'Coffee', barcode: 'coffee', quantity: 3, salePrice: 10, purchasePrice: 2, currency: 'USD' as const }];
const sale: Sale = { id: 'sale', items, subtotal: 30, total: 30, currency: 'USD', exchangeRate: 89500, cashierName: 'Cashier', date: '2026-09-30T10:00:00Z', refunded: false };
const refund: Refund = { id: 'refund', saleId: 'sale', items: [{ ...items[0], quantity: 1 }], currency: 'USD', totalRefunded: 10, cashierName: 'Cashier', date: '2026-09-30T11:00:00Z' };
it('subtracts same-day refunds exactly once', () => {
  expect(movements([sale], [refund], date => date === '2026-09-30')).toMatchObject({ totalRevenue: 20, totalCost: 4, totalProfit: 16, totalRefunded: 10 });
});
it('keeps original sale-day revenue and includes refund-only negative movements', () => {
  const later = { ...refund, date: '2026-10-01T10:00:00Z' };
  expect(movements([sale], [later], date => date === '2026-09-30').totalRevenue).toBe(30);
  expect(movements([sale], [later], date => date === '2026-10-01').totalRevenue).toBe(-10);
});
it('uses Beirut business days around UTC midnight and month boundaries', () => {
  expect(businessDate('2026-09-30T22:30:00Z')).toBe('2026-10-01');
});
it('quotes CSV fields and neutralizes spreadsheet formulas', () => {
  expect(csv([['Coffee, "large"\nsize', '=1+1', '@formula', '-danger', -10]])).toBe('"Coffee, ""large""\nsize","\'=1+1","\'@formula","\'-danger","-10"');
});
it('product searches do not include unrelated products from the same receipt', () => {
  const mixed = { ...sale, items: [...items, { ...items[0], productId: 'other', productName: 'Other', barcode: 'other', salePrice: 99 }] };
  expect(movements([mixed], [], () => true, 'coffee').totalRevenue).toBe(30);
});

it('excludes unverified legacy and orphan refund history without fabricating original sales',()=>{
 const original={...sale,legacy:true};const before=JSON.stringify(original);
 expect(movements([original],[refund],()=>true)).toMatchObject({totalRevenue:0,numSales:0,numRefunds:0});
 expect(movements([], [refund],()=>true).totalRevenue).toBe(0);expect(JSON.stringify(original)).toBe(before);
});
