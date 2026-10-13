import {describe,expect,it} from 'vitest';
import {compareLegacyInventoryToCloud,inventoryBaselineDifferences,legacyInventorySourceKey} from './legacyInventoryImport';

const products=Array.from({length:243},(_,i)=>({id:`p-${i}`,barcode:`${1000+i}`,name:`Product ${i}`,stockQuantity:i%17,purchasePrice:i+0.25,salePrice:i+1.5,isActive:true}));

describe('legacy inventory baseline review',()=>{
  it('accepts an exact 243-product cloud baseline independent of order',()=>{
    expect(compareLegacyInventoryToCloud(products,[...products].reverse())).toHaveLength(243);
  });
  it('reports exact local/cloud quantities without choosing a balance',()=>{
    const cloud=structuredClone(products);cloud[201].stockQuantity+=1;
    const diff=inventoryBaselineDifferences(products,cloud);
    expect(diff).toHaveLength(1);expect(diff[0]).toMatchObject({id:'p-201',barcode:'1201',issue:'identity, price, status, or stock differs'});
    expect(()=>compareLegacyInventoryToCloud(products,cloud)).toThrow(/1201 \[p-201\].*local stock 14, cloud stock 15/);
  });
  it('reports missing and extra cloud products instead of silently merging them',()=>{
    const cloud=[...products.slice(1),{id:'cloud-only',barcode:'x',name:'Cloud item',stockQuantity:4,purchasePrice:1,salePrice:2,isActive:true}];
    expect(inventoryBaselineDifferences(products,cloud)).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'p-0',issue:'missing from selected cloud branch'}),
      expect.objectContaining({id:'cloud-only',issue:'extra in selected cloud branch'}),
    ]));
    expect(()=>compareLegacyInventoryToCloud(products,cloud)).toThrow(/Nothing changed/);
  });
  it('treats identical quantities with different recorded branch ownership as conflicting sources',()=>{
    const base={fingerprint:'same-stock',branchAssignments:['unassigned (source schema has no branch column)'],taxColumns:[]};
    expect(legacyInventorySourceKey(base)).toBe(legacyInventorySourceKey({...base,branchAssignments:['unassigned']}));
    expect(legacyInventorySourceKey(base)).not.toBe(legacyInventorySourceKey({...base,branchAssignments:['business/palma']}));
  });
});
