import {expect,it} from 'vitest';
import {emptyBranch,visibleBranch,type LocalState} from './localDatabase';
const state = ():LocalState => ({version:2,revision:1,association:{businessId:'business',branchId:'main',businessName:'Daily',branchName:'Main',ownerUserId:'owner'},project1Settings:{business_id:'business',branch_id:'main'},outbox:[],recovery:[],branches:{unassigned:{...emptyBranch(),products:Array.from({length:17},(_,i)=>({id:'old-'+i,name:'Original '+i,barcode:'old-'+i,stockQuantity:i,purchasePrice:1,salePrice:2,legacy:true}))},'business/main':{...emptyBranch(),products:[{id:'new',name:'New',barcode:'new',stockQuantity:7,purchasePrice:1,salePrice:2}]}}});
it('shows all 17 originals and the existing branch product without modifying either bucket',()=>{
 const original=state();const before=structuredClone(original);const view=visibleBranch(original);
 expect(view.products).toHaveLength(18);expect(view.products[0].id).toBe('old-0');expect(view.products.at(-1)?.id).toBe('new');
 view.products[0].stockQuantity=999;expect(original).toEqual(before);
});
it('does not expose originals to another branch',()=>{
 const original=state();original.association!.branchId='other';original.branches['business/other']=emptyBranch();
 expect(visibleBranch(original).products).toEqual([]);expect(original.branches.unassigned.products).toHaveLength(17);
});
it('fails explicitly on conflicting identities instead of discarding one version',()=>{
 const original=state();original.branches['business/main'].products[0].id='old-0';
 expect(()=>visibleBranch(original)).toThrow('conflict');expect(original.branches.unassigned.products).toHaveLength(17);
});
