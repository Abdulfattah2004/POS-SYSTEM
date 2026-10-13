import {beforeEach,expect,it} from 'vitest';
import {holdSale,getHeldSales,resumeHeldSale,cancelHeldSale} from './heldSales';
import {initializeStore,addInventoryEntry,getProducts,getSales,addSale,updateProductStock,updateProduct} from './store';
import {addUser,login} from './localAuth';
import {getLocalState,reloadLocalState,resetLocalDatabaseForTests,localTransaction} from './localDatabase';
import {setInventoryAssociation} from './inventorySync';
let productId:string;
beforeEach(async()=>{
 localStorage.clear();await resetLocalDatabaseForTests();await initializeStore();await addUser({username:'admin',name:'Admin',role:'admin',password:'held-safe-password'},true);await login('admin','held-safe-password');
 productId=(await addInventoryEntry({productId:'',productName:'Coffee',barcode:'hold',quantityAdded:10,purchasePrice:2,salePrice:4,salesmanName:'Supplier',date:'2026-10-05'},'receipt')).productId;
});
const input=()=>({label:'Customer A',currency:'USD' as const,items:[{productId,quantity:2}]});
function saleInput(){const {cart,currency}=resumeHeldSale('hold-a');return {items:cart.map(({product,quantity})=>({productId:product.id,productName:product.name,barcode:product.barcode,quantity,purchasePrice:product.purchasePrice,salePrice:product.salePrice,currency})),subtotal:8,total:8,currency,exchangeRate:89500,cashierName:'Admin',date:new Date().toISOString(),refunded:false};}
it('multiple held carts survive reopen without sales, stock or queue effects',async()=>{
 const before=getLocalState().outbox;await holdSale(input(),'hold-a');await holdSale({...input(),label:'Customer B'},'hold-b');await reloadLocalState();
 expect(getHeldSales()).toHaveLength(2);expect(getProducts()[0].stockQuantity).toBe(10);expect(getSales()).toEqual([]);expect(getLocalState().outbox).toEqual(before);
});
it('repeat hold and cancellation are idempotent and conflicting IDs are rejected',async()=>{
 await holdSale(input(),'hold-a');await holdSale(input(),'hold-a');expect(getHeldSales()).toHaveLength(1);
 await expect(holdSale({...input(),label:'Different'},'hold-a')).rejects.toThrow('different cart');
 await cancelHeldSale('hold-a');await cancelHeldSale('hold-a');expect(getHeldSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(10);
});
it('resuming rechecks strict stock and preserves the held cart when unavailable',async()=>{
 await holdSale(input(),'hold-a');await localTransaction(state=>{state.branches.unassigned.allowNegativeStock=false;});await updateProductStock(productId,-9,'other-sale');
 expect(()=>resumeHeldSale('hold-a')).toThrow('Not enough stock');expect(getHeldSales()).toHaveLength(1);expect(getSales()).toEqual([]);
});
it('negative-stock policy permits resuming out-of-stock items and checkout revalidates prices',async()=>{
 await holdSale(input(),'hold-a');await updateProductStock(productId,-10,'no-stock');await updateProduct(productId,{salePrice:5},'price-change');
 const resumed=resumeHeldSale('hold-a');expect(resumed.pricesChanged).toBe(true);expect(resumed.cart[0].product.salePrice).toBe(5);expect(resumed.cart[0].product.stockQuantity).toBe(0);
});
it('completed held checkout consumes the cart atomically and retry produces one sale',async()=>{
 await holdSale(input(),'hold-a');const sale=saleInput();await addSale(sale,'held-checkout','hold-a');await addSale(sale,'held-checkout','hold-a');await reloadLocalState();
 expect(getHeldSales()).toEqual([]);expect(getProducts()[0].stockQuantity).toBe(8);expect(getSales()).toHaveLength(1);
});
it('competing checkouts of one held cart cannot produce two sales',async()=>{
 await holdSale(input(),'hold-a');const sale=saleInput();const outcomes=await Promise.allSettled([addSale(sale,'checkout-a','hold-a'),addSale(sale,'checkout-b','hold-a')]);
 expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);expect(getSales()).toHaveLength(1);expect(getProducts()[0].stockQuantity).toBe(8);
});
it('failed checkout leaves held cart, stock and queue intact',async()=>{
 await holdSale(input(),'hold-a');const sale=saleInput();await updateProduct(productId,{salePrice:5},'price-change');const before=getLocalState();
 await expect(addSale(sale,'failed-checkout','hold-a')).rejects.toThrow('Price changed');expect(getLocalState()).toEqual(before);expect(getHeldSales()).toHaveLength(1);
});
it('held carts cannot leak across branches or be cancelled by another cashier',async()=>{
 await addUser({username:'cashier',name:'Cashier',role:'cashier',password:'held-cashier-password'});await holdSale(input(),'hold-a');await login('cashier','held-cashier-password');
 expect(getHeldSales()).toEqual([]);expect(()=>resumeHeldSale('hold-a')).toThrow('not available');await expect(cancelHeldSale('hold-a')).rejects.toThrow('original cashier');
 await login('admin','held-safe-password');await setInventoryAssociation({businessId:'business',branchId:'other',businessName:'Business',branchName:'Other',ownerUserId:'owner'});expect(getHeldSales()).toEqual([]);
});
