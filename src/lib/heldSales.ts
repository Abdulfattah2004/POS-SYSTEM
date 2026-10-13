import type {CartItem,Currency,HeldSale} from '@/types/pos';
import {activeBranch,getLocalState,localTransaction,scopeKey,visibleBranch,resolveLocalProductId,stableJson,readHeldSales,originalRecoveryPending} from './localDatabase';
import {requireOperator,getCurrentUser} from './localAuth';
export interface HoldInput {label:string;currency:Currency;items:{productId:string;quantity:number}[]}
export function getHeldSales():HeldSale[] {
 const user=getCurrentUser();if(!user)throw new Error('Sign in before making changes.');
 return readHeldSales().filter(hold=>hold.userId===user.id||user.role==='admin');
}
export async function holdSale(input:HoldInput,id:string=crypto.randomUUID(),replacesId?:string):Promise<HeldSale> {
 const scope=scopeKey(getLocalState().association);
 return localTransaction(state=>{
  if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending)throw new Error('Held carts remain unchanged. New or resumed checkout is paused pending reviewed branch attribution.');
  const user=requireOperator(state);if(scopeKey(state.association)!==scope)throw new Error('Branch changed. Reload before holding this cart.');
  if(!id||id.length>256||input.label.length>200||!input.items.length||!['USD','LBP'].includes(input.currency))throw new Error('A held sale needs a valid ID, currency and nonempty cart.');
  const branch=activeBranch(state),products=visibleBranch(state).products;
  const seen=new Set<string>();
  const items=input.items.map(item=>{
   const productId=resolveLocalProductId(branch,item.productId),product=products.find(p=>p.id===productId&&p.isActive!==false);
   if(!product||seen.has(productId)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>2147483647)throw new Error('Held cart contains an unavailable product or invalid quantity.');
   seen.add(productId);return {productId,quantity:item.quantity,salePrice:product.salePrice};
  });
  const holds=branch.heldSales??=[];
  const existing=holds.find(hold=>hold.id===id);
  if(existing) {
   if(existing.userId!==user.id||stableJson({label:existing.label,currency:existing.currency,items:existing.items})!==stableJson({label:input.label.trim(),currency:input.currency,items}))throw new Error('Held sale ID was already used for a different cart.');
   return structuredClone(existing);
  }
  if(replacesId) {
   const replaced=holds.find(hold=>hold.id===replacesId);
   if(!replaced||(replaced.userId!==user.id&&user.role!=='admin'))throw new Error('The resumed held sale is no longer available to this account.');
   branch.heldSales=holds.filter(hold=>hold.id!==replacesId);
  }
  if((branch.heldSales??[]).length>=100)throw new Error('Resume or cancel a held cart before adding another.');
  const result:HeldSale={id,label:input.label.trim(),currency:input.currency,items,createdAt:new Date().toISOString(),userId:user.id,cashierName:user.name};
  branch.heldSales!.push(result);return structuredClone(result);
 });
}
export function resumeHeldSale(id:string):{cart:CartItem[];currency:Currency;pricesChanged:boolean} {
 const state=getLocalState(),user=requireOperator(state),branch=activeBranch(state),held=branch.heldSales?.find(hold=>hold.id===id);
 if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending)throw new Error('Held carts remain unchanged. Checkout is paused pending reviewed branch attribution.');
 if(!held||(held.userId!==user.id&&user.role!=='admin'))throw new Error('Held sale is not available to this account and branch.');
 const products=visibleBranch(state).products;let pricesChanged=false;
 const cart=held.items.map(item=>{
  const product=products.find(product=>product.id===resolveLocalProductId(branch,item.productId)&&product.isActive!==false);
  if(!product)throw new Error('A held item is archived or missing. Review this cart before checkout.');
  if(branch.allowNegativeStock===false&&product.stockQuantity<item.quantity)throw new Error(`Not enough stock to resume ${product.name}. Held cart remains saved.`);
  pricesChanged ||= product.salePrice!==item.salePrice;
  return {product:structuredClone(product),quantity:item.quantity};
 });
 return {cart,currency:held.currency,pricesChanged};
}
export async function cancelHeldSale(id:string):Promise<void> {
 const scope=scopeKey(getLocalState().association);
 await localTransaction(state=>{
  const user=requireOperator(state);if(scopeKey(state.association)!==scope)throw new Error('Branch changed. Reload held sales.');
  if(originalRecoveryPending(state) || state.legacyBranchRecovery?.reconciliationPending)throw new Error('Held carts remain unchanged pending reviewed branch attribution.');
  const branch=activeBranch(state),held=branch.heldSales?.find(hold=>hold.id===id);
  if(!held)return; // Repeated cancellation has no financial effect.
  if(held.userId!==user.id&&user.role!=='admin')throw new Error('Only the original cashier or an administrator can cancel this held sale.');
  branch.heldSales=branch.heldSales!.filter(hold=>hold.id!==id);
 });
}
