import {expect,it} from 'vitest';
import {settlementPreview} from './settlement';
it('previews fractional legacy prices with the same cent and whole-LBP rounding as committed sales',()=>{
 expect(settlementPreview([{salePrice:0.333,quantity:1}],'LBP',89500)).toEqual({subtotal:0.33,total:29535});
 expect(settlementPreview([{salePrice:0.01,quantity:1}],'LBP',100001)).toEqual({subtotal:0.01,total:1000});
 expect(settlementPreview([{salePrice:0.1,quantity:3}],'USD',89500)).toEqual({subtotal:0.3,total:0.3});
});
it('refund previews sum each original-sale settlement rather than rounding the whole batch',()=>{
 const lines=[{saleId:'a',salePrice:0.01,quantity:1},{saleId:'b',salePrice:0.01,quantity:1}];
 expect(settlementPreview(lines,'LBP',150)).toEqual({subtotal:0.02,total:4});
 expect(settlementPreview(lines,'USD',150)).toEqual({subtotal:0.02,total:0.02});
});
