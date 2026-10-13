// @vitest-environment node
// Synthetic local integration: actual POS store/outbox + isolated PostgreSQL RPCs.
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {databaseFixture} from '../test/databaseFixture';
import {initializeStore,addInventoryEntry,addSale,addPartialRefund,getProducts,getSales,getRefunds} from './store';
import {addUser,login} from './localAuth';
import {getLocalState,reloadLocalState,resetLocalDatabaseForTests,localTransaction} from './localDatabase';
import {setInventoryAssociation,syncPendingInventory,retryInventoryOperations,loadInventoryFromSupabase} from './inventorySync';
import {supabaseClient} from './supabase';
import {normalizeSnapshot} from '../../dashboard-candidate/src/lib/financial';
const business='11111111-1111-1111-1111-111111111111',branch='22222222-2222-2222-2222-222222222222',owner='33333333-3333-3333-3333-333333333333';
let db:PGlite;let online=true;let loseAck=false;const storage=new Map<string,string>();
beforeAll(async()=>{
 vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key),key:(index:number)=>[...storage.keys()][index]??null,get length(){return storage.size;}});
 vi.stubGlobal('navigator',{get onLine(){return online;}});vi.stubEnv('VITE_POS_SYNC_ENABLED','true');
 db=new PGlite();await db.exec(databaseFixture(business,branch,owner));await db.exec(readFileSync('database-docs/pos_sync_v2_review.sql','utf8'));await db.exec(`INSERT INTO pos_v2_branch_gate VALUES('${business}','${branch}',true,'2026-09-01','synthetic local integration');SET request.jwt.claim.sub='${owner}'`);
 vi.spyOn(supabaseClient!.auth,'getUser').mockResolvedValue({data:{user:{id:owner}},error:null} as never);
 vi.spyOn(supabaseClient!,'rpc').mockImplementation((name,args)=>{
 const run=async()=>{try{const fn=name==='pos_commit_operation'?'SELECT pos_commit_operation($1::jsonb) AS data':name==='pos_branch_snapshot'?'SELECT pos_branch_snapshot($1::uuid,$2::uuid) AS data':'SELECT pos_sync_protocol() AS data';const values=name==='pos_commit_operation'?[JSON.stringify((args as {p_operation:unknown}).p_operation)]:name==='pos_branch_snapshot'?[business,branch]:[];const response=await db.query<{data:unknown}>(fn,values);if(name==='pos_commit_operation'&&loseAck){loseAck=false;return {data:null,error:{message:'Synthetic lost acknowledgment'}};}return {data:response.rows[0].data,error:null};}catch(error){return {data:null,error:{message:(error as Error).message,code:(error as {code?:string}).code}};}};return run() as never;
 });
 await resetLocalDatabaseForTests();await initializeStore();await addUser({username:'qa',name:'QA',role:'admin',password:'synthetic-safe-password'},true);await login('qa','synthetic-safe-password');await setInventoryAssociation({businessId:business,branchId:branch,ownerUserId:owner,businessName:'Synthetic',branchName:'QA'});
},60000);
afterAll(async()=>{await syncPendingInventory();vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();await db?.close();});
it('actual PostgreSQL snapshot retains a reviewed historical empty-product receipt while strict new operations remain valid',async()=>{
 const original={id:'preserved-legacy-receipt',productId:'',productName:'Original coffee',barcode:'original-coffee',quantityAdded:3,purchasePrice:2,salePrice:4,salesmanName:'Original supplier',date:'2020-01-01',legacy:true};
 await db.query('INSERT INTO inventory_entries(id,business_id,branch_id,product_id,product_name,barcode,quantity_added,purchase_price,sale_price,salesman_name,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[original.id,business,branch,original.productId,original.productName,original.barcode,original.quantityAdded,original.purchasePrice,original.salePrice,original.salesmanName,original.date]);
 await localTransaction(state=>{state.branches[`${business}/${branch}`].entries.push(original);});
 const before=getLocalState().outbox;
 await loadInventoryFromSupabase();
 expect(getLocalState().branches[`${business}/${branch}`].entries).toEqual([original]);expect(getLocalState().outbox).toEqual(before);
 expect((await db.query('SELECT * FROM pos_v2_operations')).rows).toHaveLength(0);
},60000);
it('10 -> 8 -> 9 stays consistent through actual POS queue, database, dashboard snapshot, lost ack and restart',async()=>{
 const date=new Date().toISOString();await addInventoryEntry({productId:'',productName:'QA Product',barcode:'qa-e2e',quantityAdded:10,purchasePrice:2,salePrice:4,salesmanName:'QA',date},'qa-receipt');await syncPendingInventory();expect(getLocalState().outbox).toEqual([]);
 const p=getProducts()[0];const input={items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:2,purchasePrice:2,salePrice:4,currency:'USD' as const}],subtotal:8,total:8,currency:'USD' as const,exchangeRate:89500,cashierName:'QA',date,refunded:false};
 online=false;const sold=await addSale(input,'qa-sale');await reloadLocalState();expect(getProducts()[0].stockQuantity).toBe(8);expect(getLocalState().outbox).toHaveLength(1);expect((await db.query<{stock:number}>('SELECT stock FROM products')).rows[0].stock).toBe(10);
 online=true;loseAck=true;await syncPendingInventory();expect(getLocalState().outbox).toHaveLength(1);expect((await db.query<{stock:number}>('SELECT stock FROM products')).rows[0].stock).toBe(8);await reloadLocalState();await retryInventoryOperations();expect(getLocalState().outbox).toEqual([]);await addSale(input,'qa-sale');
 const returned=await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','qa-refund');await syncPendingInventory();await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','qa-refund');await reloadLocalState();await loadInventoryFromSupabase();expect(getProducts()[0].stockQuantity).toBe(9);expect(getSales()).toHaveLength(1);expect(getRefunds()).toHaveLength(1);expect(getSales()[0].items[0].quantity).toBe(2);expect(returned.totalRefunded).toBe(4);
 const snap=(await db.query<{data:{products:{stock:number}[];sales:{record:{subtotal:number}}[];refunds:{record:{totalRefunded:number}}[]}}>(`SELECT pos_dashboard_snapshot('${business}',ARRAY['${branch}']::uuid[]) AS data`)).rows[0].data;expect(snap.products[0].stock).toBe(9);expect(snap.sales).toHaveLength(1);expect(snap.refunds).toHaveLength(1);expect(snap.sales[0].record.subtotal-snap.refunds[0].record.totalRefunded).toBe(4);expect((await db.query('SELECT * FROM sale_items')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM refund_items')).rows).toHaveLength(1);
 const dashboard = normalizeSnapshot(snap,business,[branch]);
 expect(dashboard.products[0].stock).toBe(9);
 expect(dashboard.sales.reduce((total,event)=>total+event.total,0)).toBe(4);
 expect(dashboard.saleItems.reduce((quantity,item)=>quantity+item.quantity,0)).toBe(1);
},60000);

it('approved negative-stock fulfillment is consistent across POS, database and actual Dashboard calculations',async()=>{
 await db.exec('UPDATE pos_v2_branch_gate SET allow_negative_stock=true');await loadInventoryFromSupabase();
 const p=getProducts()[0],date=new Date().toISOString();
 const input={items:[{productId:p.id,productName:p.name,barcode:p.barcode,quantity:10,purchasePrice:2,salePrice:4,currency:'USD' as const}],subtotal:40,total:40,currency:'USD' as const,exchangeRate:89500,cashierName:'QA',date,refunded:false};
 const sold=await addSale(input,'negative-e2e-sale');await syncPendingInventory();await addSale(input,'negative-e2e-sale');await reloadLocalState();await loadInventoryFromSupabase();
 expect(getProducts()[0].stockQuantity).toBe(-1);
 await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','negative-e2e-refund');await syncPendingInventory();await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','negative-e2e-refund');await reloadLocalState();await loadInventoryFromSupabase();
 expect(getProducts()[0].stockQuantity).toBe(0);
 const raw=(await db.query<{data:unknown}>(`SELECT pos_dashboard_snapshot('${business}',ARRAY['${branch}']::uuid[]) AS data`)).rows[0].data;
 const dashboard=normalizeSnapshot(raw,business,[branch]);expect(dashboard.products[0].stock).toBe(0);expect(dashboard.sales.reduce((n,event)=>n+event.total,0)).toBe(40);
 expect(dashboard.sales.filter(event=>event.original_id==='negative-e2e-sale')).toHaveLength(1);expect(getLocalState().outbox).toEqual([]);
});

it('multi-line RPC canonical ordering refreshes without rewriting immutable local sale/refund history',async()=>{
 const date=new Date().toISOString();
 for(const barcode of ['ordered-a','ordered-z']) {
  await addInventoryEntry({productId:'',productName:barcode,barcode,quantityAdded:10,purchasePrice:2,salePrice:4,salesmanName:'QA',date});
  await syncPendingInventory();
 }
 const products=getProducts().filter(p=>p.barcode.startsWith('ordered-')).sort((a,b)=>a.id>b.id?-1:1);
 expect(products).toHaveLength(2);
 const sold=await addSale({items:products.map(p=>({productId:p.id,productName:p.name,barcode:p.barcode,quantity:1,purchasePrice:p.purchasePrice,salePrice:p.salePrice,currency:'USD'})),subtotal:8,total:8,currency:'USD',exchangeRate:89500,cashierName:'QA',date,refunded:false},'ordered-sale');
 await syncPendingInventory();expect(getLocalState().outbox).toEqual([]);
 const remote=(await db.query<{record:typeof sold}>('SELECT record FROM pos_v2_sales WHERE id=$1',[sold.id])).rows[0].record;
 expect(remote.items.map(i=>i.productId)).toEqual([...sold.items.map(i=>i.productId)].sort());
 expect(remote.items).not.toEqual(sold.items); // Reproduces the native immutability failure in 0.3.3.
 await loadInventoryFromSupabase();expect(getSales().find(s=>s.id===sold.id)).toEqual(sold);
 const returned=await addPartialRefund(sold.id,sold.items.map(i=>({...i,quantity:1})),'QA','ordered-refund');
 await syncPendingInventory();await loadInventoryFromSupabase();await reloadLocalState();await loadInventoryFromSupabase();
 expect(getSales().find(s=>s.id===sold.id)).toEqual(sold);expect(getRefunds().find(r=>r.id===returned.id)).toEqual(returned);
 expect(getProducts().filter(p=>p.barcode.startsWith('ordered-')).map(p=>p.stockQuantity)).toEqual([10,10]);
 expect((await db.query('SELECT * FROM pos_v2_sales WHERE id=$1',[sold.id])).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM pos_v2_refunds WHERE id=$1',[returned.id])).rows).toHaveLength(1);
 const raw=(await db.query<{data:unknown}>('SELECT pos_dashboard_snapshot($1::uuid,ARRAY[$2::uuid]) data',[business,branch])).rows[0].data;
 const dashboard=normalizeSnapshot(raw,business,[branch]);
 expect(dashboard.sales.reduce((sum,event)=>sum+event.total,0)).toBe(40);
 expect(getLocalState().outbox).toEqual([]);
},30000);

it('legacy archive stays frozen while verified branch offline cash sales and refunds reach SQL and Dashboard exactly once',async()=>{
 const date=new Date().toISOString();
 await addInventoryEntry({productId:'',productName:'Verified legacy-safe inventory',barcode:'verified-legacy-safe',quantityAdded:10,purchasePrice:1,salePrice:2,salesmanName:'QA',date},'legacy-safe-receipt');await syncPendingInventory();
 const initialDashboard=normalizeSnapshot((await db.query<{data:unknown}>(`SELECT pos_dashboard_snapshot('${business}',ARRAY['${branch}']::uuid[]) AS data`)).rows[0].data,business,[branch]);
 const baseline=getProducts();
 await localTransaction(state=>{
  state.branches.unassigned.products=structuredClone(baseline).map(p=>({...p,legacy:true}));
  state.branches.unassigned.sales=Array.from({length:22220},(_,i)=>({id:`preserved-history-${i}`,legacy:true,items:[],subtotal:2,total:2,currency:'USD',exchangeRate:89500,cashierName:'Original',date:'2020-01-01',refunded:false}));
  state.outbox.push({operationId:'original-receipt-not-replayed',type:'stock_delta',productId:baseline[0].id,quantityDelta:8,businessId:business,branchId:branch,blocked:true,quarantined:'Preserved ambiguous operation'}, {operationId:'original-sale-not-replayed',type:'stock_delta',productId:baseline[0].id,quantityDelta:-1,businessId:null,branchId:null,blocked:true,quarantined:'Preserved ambiguous operation'});
  // Native activation, backup and CAS are exercised with real SQLite in Rust.
  // This fixture tests the resulting proof through the real SQL sync protocol.
  state.inventoryActivation={businessId:business,branchId:branch,backupId:'synthetic-backup',backupSHA256:'a'.repeat(64),inventorySHA256:'b'.repeat(64),historicalOperationIds:['original-receipt-not-replayed','original-sale-not-replayed']};
 });
 const original=getLocalState().branches.unassigned,originalQueue=getLocalState().outbox;
 const product=getProducts().find(p=>p.barcode==='verified-legacy-safe')!;
 const input={items:[{productId:product.id,productName:product.name,barcode:product.barcode,quantity:2,purchasePrice:1,salePrice:2,currency:'USD' as const}],subtotal:4,total:4,currency:'USD' as const,exchangeRate:89500,cashierName:'QA',date,refunded:false};
 online=false;const sold=await addSale(input,'legacy-safe-sale');await reloadLocalState();await addSale(input,'legacy-safe-sale');expect(getProducts().find(p=>p.id===product.id)!.stockQuantity).toBe(8);
 expect((await db.query<{stock:number}>('SELECT stock FROM products WHERE id=$1',[product.id])).rows[0].stock).toBe(10);
 online=true;loseAck=true;await syncPendingInventory();await reloadLocalState();await retryInventoryOperations();await loadInventoryFromSupabase();
 expect((await db.query<{stock:number}>('SELECT stock FROM products WHERE id=$1',[product.id])).rows[0].stock).toBe(8);
 await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','legacy-safe-refund');await reloadLocalState();await syncPendingInventory();await addPartialRefund(sold.id,[{...sold.items[0],quantity:1}],'QA','legacy-safe-refund');await retryInventoryOperations();await loadInventoryFromSupabase();
 const raw=(await db.query<{data:unknown}>(`SELECT pos_dashboard_snapshot('${business}',ARRAY['${branch}']::uuid[]) AS data`)).rows[0].data;
 const dashboard=normalizeSnapshot(raw,business,[branch]);expect(dashboard.products.find(p=>p.id===product.id)!.stock).toBe(9);expect(getProducts().find(p=>p.id===product.id)!.stockQuantity).toBe(9);
 expect(dashboard.sales.filter(s=>s.original_id==='legacy-safe-sale')).toHaveLength(1);expect(dashboard.sales.reduce((n,s)=>n+s.total,0)-initialDashboard.sales.reduce((n,s)=>n+s.total,0)).toBe(2);
 expect((await db.query('SELECT * FROM pos_v2_operations WHERE operation_id IN ($1,$2)',['original-receipt-not-replayed','original-sale-not-replayed'])).rows).toHaveLength(0);
 expect((await db.query('SELECT * FROM pos_v2_sales WHERE id=$1',['legacy-safe-sale'])).rows).toHaveLength(1);expect((await db.query('SELECT * FROM pos_v2_refunds WHERE id=$1',['legacy-safe-refund:0'])).rows).toHaveLength(1);
 expect(getLocalState().branches.unassigned).toEqual(original);expect(getLocalState().outbox).toEqual(originalQueue);
},60000);
