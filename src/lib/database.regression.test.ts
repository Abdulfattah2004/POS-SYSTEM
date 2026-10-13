import {databaseFixture} from '../test/databaseFixture';
// @vitest-environment node
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';

// This database is ephemeral WASM PostgreSQL. No URL, production credentials,
// remote connections, or production SQL tools are used by these tests.
let db: PGlite;
const business = '11111111-1111-1111-1111-111111111111';
const branch = '22222222-2222-2222-2222-222222222222';
const owner = '33333333-3333-3333-3333-333333333333';
const other = '44444444-4444-4444-4444-444444444444';
const migration = readFileSync('database-docs/pos_sync_v2_review.sql', 'utf8');
const receipt = (id = 'receipt-1', productId = 'product-1', qty = 5) => ({
  protocolRevision: 3, operationId: id, businessId: business, branchId: branch, type: 'receive',
  entry: { id, productId, productName: 'Coffee', barcode: 'coffee', quantityAdded: qty, purchasePrice: 2, salePrice: 4, salesmanName: 'Sam', date: '2026-09-30T10:00:00Z' },
  product: { id: productId, name: 'Coffee', barcode: 'coffee', stockQuantity: qty, purchasePrice: 2, salePrice: 4 },
});
const sale = (id = 'sale-1', qty = 1) => ({
  protocolRevision: 3, operationId: 'sale:' + id, businessId: business, branchId: branch, type: 'sale',
  sale: { id, items: [{ productId: 'product-1', productName: 'Coffee', barcode: 'coffee', quantity: qty, salePrice: 4, purchasePrice: 2, currency: 'USD' }], subtotal: 4 * qty, total: 4 * qty, currency: 'USD', exchangeRate: 89500, cashierName: 'Cashier', date: '2026-09-30T11:00:00Z', refunded: false },
});
const refund = (id = 'refund-1', qty = 1) => ({
  protocolRevision: 3, operationId: 'refund:' + id, businessId: business, branchId: branch, type: 'refund',
  refund: { id, saleId: 'sale-1', items: [{ ...sale().sale.items[0], quantity: qty }], totalRefunded: 4 * qty, currency: 'USD', exchangeRate: 89500, cashierName: 'Cashier', date: '2026-09-30T12:00:00Z' },
});
async function commit(operation: unknown) {
  const response = await db.query<{ result: { confirmed: boolean; already_processed: boolean; product_ids: Record<string, string> } }>('SELECT public.pos_commit_operation($1::jsonb) AS result', [JSON.stringify({ createdAt: '2026-09-30T10:00:00Z', ...(operation as object) })]);
  return response.rows[0].result;
}
async function stock() { return (await db.query<{ stock: number }>('SELECT stock FROM public.products WHERE id=$1', ['product-1'])).rows[0]?.stock; }
const liveShapeFixture = databaseFixture(business,branch,owner);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(liveShapeFixture);
  await db.exec(migration);
  await db.exec(`INSERT INTO public.pos_v2_branch_gate VALUES('${business}','${branch}',true,'2026-09-01','synthetic local fixture')`);
}, 60000);
beforeEach(async () => {
  await db.exec(`RESET ROLE; DELETE FROM public.refund_items; DELETE FROM public.refunds; DELETE FROM public.sale_items; DELETE FROM public.sales; UPDATE public.pos_v2_branch_gate SET writes_enabled=true,allow_negative_stock=false; DELETE FROM public.pos_v2_operations; DELETE FROM public.pos_v2_refunds; DELETE FROM public.pos_v2_sales; DELETE FROM public.inventory_entries; DELETE FROM public.inventory_sync_operations; DELETE FROM public.products; SET request.jwt.claim.sub='${owner}';`);
});
afterAll(async () => { await db?.close(); });
it('requires explicit review approval before migration', async () => {
  await db.exec("SET pos.review_approved='no'");
  await expect(db.exec(migration)).rejects.toThrow('explicitly approve');
  await db.exec("ROLLBACK; SET pos.review_approved='yes'");
});
it('new-product receipts commit and retry without duplicate stock', async () => {
  expect((await commit(receipt())).confirmed).toBe(true);
  await commit(receipt());
  expect(await stock()).toBe(5);
  expect((await db.query('SELECT * FROM inventory_entries')).rows).toHaveLength(1);
});
it('uses the real Supabase identity function without granting executor access to managed auth schema', async () => {
  const before = (await db.query("SELECT nspacl::text FROM pg_namespace WHERE nspname='auth'")).rows;
  expect((await db.query<{allowed:boolean}>("SELECT has_schema_privilege('pos_v2_executor','auth','USAGE') AS allowed")).rows[0].allowed).toBe(false);
  expect((await commit(receipt())).confirmed).toBe(true);
  await db.exec('SET ROLE authenticated');
  const snapshot = (await db.query<{s:{products:unknown[]}}> ('SELECT pos_dashboard_snapshot($1,$2::uuid[]) AS s',[business,[branch]])).rows[0].s;
  expect(snapshot.products).toHaveLength(1);
  await db.exec('RESET ROLE');
  expect((await db.query("SELECT nspacl::text FROM pg_namespace WHERE nspname='auth'")).rows).toEqual(before);
});
it('keeps the cached identity adapter private and nonprivileged', async () => {
  const definition = (await db.query<{safe:boolean}>("SELECT NOT prosecdef AND prosqlbody IS NOT NULL AS safe FROM pg_proc WHERE oid='public.pos_authenticated_owner_id()'::regprocedure")).rows[0];
  expect(definition.safe).toBe(true);
  for (const role of ['anon','authenticated','service_role']) {
    expect((await db.query<{allowed:boolean}>("SELECT has_function_privilege($1,'public.pos_authenticated_owner_id()','EXECUTE') AS allowed",[role])).rows[0].allowed).toBe(false);
  }
  await db.exec('SET ROLE authenticated');
  await expect(db.query('SELECT public.pos_authenticated_owner_id()')).rejects.toThrow('permission');
});

it('server-owned negative-stock policy permits sales below zero and retries without duplicating financial or stock effects',async()=>{
  await db.exec('UPDATE pos_v2_branch_gate SET allow_negative_stock=true');
  await commit(receipt('receipt-1','product-1',1));await commit(sale('sale-1',3));await commit(sale('sale-1',3));
  expect(await stock()).toBe(-2);await commit(refund('refund-1',1));await commit(refund('refund-1',1));expect(await stock()).toBe(-1);
  await commit(receipt('topup','product-1',1));await commit(receipt('topup','product-1',1));expect(await stock()).toBe(0);
  expect((await db.query('SELECT * FROM sales')).rows).toHaveLength(1);expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
  await db.exec('SET ROLE authenticated');await expect(db.exec('UPDATE pos_v2_branch_gate SET allow_negative_stock=true')).rejects.toThrow('permission');
});

it('competing device requests follow the explicit strict or negative-stock policy without lost updates',async()=>{
 await commit(receipt('receipt-1','product-1',1));
 const strict=await Promise.allSettled([commit(sale('device-a',1)),commit(sale('device-b',1))]);expect(strict.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await stock()).toBe(0);
 await db.exec('UPDATE pos_v2_branch_gate SET allow_negative_stock=true');
 const permitted=await Promise.allSettled([commit(sale('device-c',1)),commit(sale('device-d',1))]);expect(permitted.every(result=>result.status==='fulfilled')).toBe(true);expect(await stock()).toBe(-2);
 await commit(sale('device-c',1));await commit(sale('device-d',1));expect(await stock()).toBe(-2);expect((await db.query('SELECT * FROM sales')).rows).toHaveLength(3);
});
it('resolves barcode to canonical product identity', async () => {
  await commit(receipt());
  const result = await commit(receipt('receipt-2', 'offline-product', 2));
  expect(result.product_ids['offline-product']).toBe('product-1');
  expect(await stock()).toBe(7);
});
it('different operations cannot replay the same receipt', async () => {
  const first = receipt(); await commit(first);
  await commit({ ...first, operationId: 'another-id' });
  expect(await stock()).toBe(5);
  await expect(commit({ ...receipt('receipt-1', 'product-1', 7), operationId: 'conflict' })).rejects.toThrow('conflicting');
  expect(await stock()).toBe(5);
});
it('rejects changed payloads for a completed operation', async () => {
  await commit(receipt());
  await expect(commit(receipt('receipt-1', 'product-1', 9))).rejects.toThrow('immutable');
  expect(await stock()).toBe(5);
});
it('preserves and honors a successful legacy ledger without replaying stock', async () => {
  await commit(receipt());
  await db.exec(`INSERT INTO inventory_sync_operations VALUES('old-delta','${business}','${branch}','product-1',-1,'stock_delta','succeeded','{}')`);
  const before = (await db.query('SELECT * FROM inventory_sync_operations')).rows;
  await db.exec(migration);
  await commit({ protocolRevision: 3, operationId: 'old-delta', businessId: business, branchId: branch, type: 'stock_delta', productId: 'product-1', quantityDelta: -1 });
  expect(await stock()).toBe(5);
  expect((await db.query('SELECT * FROM inventory_sync_operations')).rows).toEqual(before);
});
it('blocks ambiguous legacy statuses instead of replaying them', async () => {
  await commit(receipt());
  await db.exec(`INSERT INTO inventory_sync_operations VALUES('old-delta','${business}','${branch}','product-1',-1,'stock_delta','processing','{}')`);
  await expect(commit({ protocolRevision: 3, operationId: 'old-delta', businessId: business, branchId: branch, type: 'stock_delta', productId: 'product-1', quantityDelta: -1 })).rejects.toThrow('reconciliation');
  expect(await stock()).toBe(5);
});
it('persists complete sale and refund once while preserving original sale', async () => {
  await commit(receipt()); await commit(sale()); await commit(sale());
  const original = (await db.query('SELECT record FROM pos_v2_sales')).rows;
  await commit(refund()); await commit(refund());
  expect(await stock()).toBe(5);
  expect((await db.query('SELECT record FROM pos_v2_sales')).rows).toEqual(original);
  expect((await db.query('SELECT record FROM pos_v2_refunds')).rows).toHaveLength(1);
});
it('prevents excessive refunds and derives prices from original sale', async () => {
  await commit(receipt()); await commit(sale()); await commit(refund());
  await expect(commit(refund('another-refund'))).rejects.toThrow('exceeds');
  const request = refund('wrong-price'); request.refund.items[0].salePrice = 99;
  await expect(commit(request)).rejects.toThrow();
  expect(await stock()).toBe(5);
});
it('prevents cloud overselling and rolls back full financial operation', async () => {
  await commit(receipt('receipt-1', 'product-1', 1)); await commit(sale());
  await expect(commit(sale('sale-2'))).rejects.toThrow('Insufficient');
  expect(await stock()).toBe(0);
  expect((await db.query('SELECT * FROM pos_v2_sales')).rows).toHaveLength(1);
});
it('rejects malformed totals and fractional quantities without partial writes', async () => {
  await commit(receipt());
  const request = sale(); request.sale.total = 999;
  await expect(commit(request)).rejects.toThrow('total mismatch');
  await expect(commit(sale('fractional', 1.5))).rejects.toThrow();
  expect(await stock()).toBe(5);
  expect((await db.query('SELECT * FROM pos_v2_sales')).rows).toEqual([]);
});
it('enforces business ownership and branch membership', async () => {
  await db.exec(`SET request.jwt.claim.sub='${other}'`);
  await expect(commit(receipt())).rejects.toThrow('Unauthorized');
  await db.exec(`SET request.jwt.claim.sub='${owner}'`);
  await expect(commit({ ...receipt(), branchId: other })).rejects.toThrow('Unauthorized');
});
it('does not give authenticated clients direct ledger or financial write access', async () => {
  await db.exec('SET ROLE authenticated');
  await expect(db.exec("INSERT INTO pos_v2_operations VALUES('rogue',null,null,'{}','{}',now())")).rejects.toThrow('permission');
  await expect(db.exec("INSERT INTO pos_v2_sales VALUES('rogue',null,null,'{}',now())")).rejects.toThrow('permission');
  expect((await commit(receipt())).confirmed).toBe(true);
});
it('anonymous sessions cannot call the mutation RPC', async () => {
  await db.exec('SET ROLE anon');
  await expect(commit(receipt())).rejects.toThrow('permission');
});
it('shared products are rejected rather than assigned to a branch', async () => {
  await db.exec(`INSERT INTO products(id,business_id,barcode,name,stock,price,cost) VALUES('shared','${business}','coffee','Coffee',10,4,2)`);
  await expect(commit(receipt())).rejects.toThrow('Shared');
  expect((await db.query('SELECT stock,branch_id FROM products')).rows).toEqual([{ stock: 10, branch_id: null }]);
});
it('snapshot returns full records and reflects product tombstones', async () => {
  await commit(receipt());
  await commit({ protocolRevision: 3, operationId: 'delete-1', businessId: business, branchId: branch, type: 'product_delete', productId: 'product-1' });
  const response = await db.query<{ snapshot: { products: unknown[]; entries: unknown[] } }>('SELECT pos_branch_snapshot($1,$2) AS snapshot', [business, branch]);
  expect(response.rows[0].snapshot.products).toEqual([expect.objectContaining({isActive:false})]);
  expect(response.rows[0].snapshot.entries).toHaveLength(1);
});
it('receipt metadata is editable but financial receipt history cannot be changed', async () => {
  await commit(receipt());
  await expect(commit({ protocolRevision: 3, operationId: 'edit-amount', businessId: business, branchId: branch, type: 'inventory_entry_update', entryId: 'receipt-1', updates: { quantityAdded: 99 } })).rejects.toThrow('immutable');
  await commit({ protocolRevision: 3, operationId: 'edit-name', businessId: business, branchId: branch, type: 'inventory_entry_update', entryId: 'receipt-1', updates: { salesmanName: 'Alex' } });
  await commit({ protocolRevision: 3, operationId: 'legacy-delete', businessId: business, branchId: branch, type: 'inventory_entry_delete', entryId: 'receipt-1' });
  expect((await db.query('SELECT salesman_name,quantity_added FROM inventory_entries')).rows).toEqual([{ salesman_name: 'Alex', quantity_added: 5 }]);
  expect(await stock()).toBe(5);
});
it('multiple incoming IDs cannot conceal duplicate canonical sale lines', async () => {
  await commit(receipt());
  const request = sale();
  request.sale.items.push({ ...request.sale.items[0], productId: 'another-offline-id' });
  request.sale.subtotal = request.sale.total = 8;
  await expect(commit(request)).rejects.toThrow('same canonical');
  expect(await stock()).toBe(5);
});

it('rejects absent operation kind and missing financial fields without any writes', async () => {
  await expect(commit({ protocolRevision: 3, operationId: 'missing-kind', businessId: business, branchId: branch })).rejects.toThrow('Unsupported');
  await commit(receipt());
  const request = sale();
  delete (request.sale as { currency?: string }).currency;
  await expect(commit(request)).rejects.toThrow('Invalid financial');
  expect(await stock()).toBe(5);
  expect((await db.query('SELECT * FROM pos_v2_sales')).rows).toEqual([]);
});

it('writes normalized Dashboard sale and refund records atomically with immutable records', async () => {
 await commit(receipt()); await commit(sale()); await commit(refund());
 expect((await db.query('SELECT * FROM sales')).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM sale_items')).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(1);
 expect((await db.query('SELECT * FROM refund_items')).rows).toHaveLength(1);
 expect((await db.query<{total:string}>('SELECT total FROM sales')).rows[0].total).toBe('4');
});
it('does not activate synchronization merely by installing the protocol', async () => {
 await db.exec('UPDATE pos_v2_branch_gate SET writes_enabled=false');
 await expect(commit(receipt())).rejects.toThrow('disabled');
 expect(await stock()).toBeUndefined();
});
it('blocks unmarked pre-cutover operations when the old ledger is absent', async () => {
 await db.exec('ALTER TABLE inventory_sync_operations RENAME TO dormant_ledger');
 try { const old = {...receipt(), protocolRevision: undefined}; await expect(commit(old)).rejects.toThrow('Pre-cutover'); }
 finally { await db.exec('ALTER TABLE dormant_ledger RENAME TO inventory_sync_operations'); }
});
it('blocks sales when existing stock is negative without resetting the stock', async () => {
 await commit(receipt()); await db.exec('UPDATE products SET stock=-2');
 await expect(commit(sale())).rejects.toThrow('Negative'); expect(await stock()).toBe(-2);
});
it('rolls stock and financial ledger back when a legacy sale ID already exists', async () => {
 await commit(receipt()); await db.exec(`INSERT INTO sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date) VALUES('sale-1','${business}','${branch}',4,4,'USD',89500,'legacy','2020-01-01')`);
 await expect(commit(sale())).rejects.toThrow(); expect(await stock()).toBe(5);
 expect((await db.query('SELECT * FROM pos_v2_sales')).rows).toHaveLength(0);
});

it('owner Dashboard snapshot returns immutable financial records and preserves incomplete legacy history', async () => {
 await commit(receipt()); await commit(sale()); await commit(refund());
 await db.exec(`INSERT INTO sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date) VALUES('legacy','${business}','${branch}',999,999,'USD',89500,'legacy','2020-01-01')`);
 const before=(await db.query('SELECT * FROM sales ORDER BY id')).rows;
 await db.exec('SET ROLE authenticated');
 const snap=(await db.query<{s:{sales:unknown[];refunds:unknown[];historical:{sales:{id:string}[]}}}>('SELECT pos_dashboard_snapshot($1,$2::uuid[]) AS s',[business,[branch]])).rows[0].s;
 expect(snap.sales).toHaveLength(1); expect(snap.refunds).toHaveLength(1);expect(snap.historical.sales[0].id).toBe('legacy');
 await db.exec('RESET ROLE');expect((await db.query('SELECT * FROM sales ORDER BY id')).rows).toEqual(before);
});
it('Dashboard snapshot rejects foreign empty and anonymous scopes', async () => {
 await expect(db.query('SELECT pos_dashboard_snapshot($1,$2::uuid[])',[business,[other]])).rejects.toThrow('Unauthorized');
 await expect(db.query('SELECT pos_dashboard_snapshot($1,$2::uuid[])',[business,[]])).rejects.toThrow('Unauthorized');
 await db.exec(`SET request.jwt.claim.sub='${other}'`);
 await expect(db.query('SELECT pos_dashboard_snapshot($1,$2::uuid[])',[business,[branch]])).rejects.toThrow('Unauthorized');
 await db.exec('SET ROLE anon'); await expect(db.query('SELECT pos_dashboard_snapshot($1,$2::uuid[])',[business,[branch]])).rejects.toThrow('permission');
});
it('clients cannot bypass transactions by writing normalized financial or stock tables', async () => {
 await commit(receipt());await db.exec('SET ROLE authenticated');
 for(const table of ['sales','sale_items','refunds','refund_items','products','inventory_entries']) await expect(db.exec(`DELETE FROM ${table}`)).rejects.toThrow('permission');
 await expect(db.exec('UPDATE products SET stock=999')).rejects.toThrow('permission');
});
it('pre-cutover transactions and changed costs do not alter stock', async () => {
 const old=receipt();old.entry.date='2020-01-01';await expect(commit(old)).rejects.toThrow('predates');
 await commit(receipt());const changed=sale();changed.sale.items[0].purchasePrice=1;await expect(commit(changed)).rejects.toThrow('cost changed');expect(await stock()).toBe(5);
});
it('executor has no login bypass inherited roles or permanent SET membership', async () => {
 const roles=await db.query<{rolcanlogin:boolean;rolbypassrls:boolean;rolsuper:boolean}>("SELECT rolcanlogin,rolbypassrls,rolsuper FROM pg_roles WHERE rolname='pos_v2_executor'");expect(roles.rows[0]).toEqual({rolcanlogin:false,rolbypassrls:false,rolsuper:false});
 const members=await db.query<{set_option:boolean;inherit_option:boolean}>("SELECT set_option,inherit_option FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='pos_v2_executor')");expect(members.rows.every(m=>!m.set_option&&!m.inherit_option)).toBe(true);
});

it('migration runs under a PostgreSQL 17 non-superuser role creator and can be re-applied', async () => {
 const isolated=new PGlite();
 try {
 await isolated.exec(liveShapeFixture);
 await isolated.exec(`CREATE ROLE staged_deployer NOLOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE;
 GRANT USAGE,CREATE ON SCHEMA public TO staged_deployer WITH GRANT OPTION;
 GRANT USAGE ON SCHEMA auth TO staged_deployer WITH GRANT OPTION;
 DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['businesses','branches','products','inventory_entries','sales','sale_items','refunds','refund_items','inventory_sync_operations'] LOOP EXECUTE format('ALTER TABLE public.%I OWNER TO staged_deployer',t); END LOOP; END $$;
 SET SESSION AUTHORIZATION staged_deployer; SET pos.review_approved='yes';`);
 await isolated.exec(migration);await isolated.exec(migration);
 const permissions=await isolated.query<{set_option:boolean;inherit_option:boolean;admin_option:boolean}>("SELECT set_option,inherit_option,admin_option FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='pos_v2_executor')");
 expect(permissions.rows.some(m=>m.admin_option)).toBe(true);
 expect(permissions.rows.every(m=>!m.set_option&&!m.inherit_option)).toBe(true);
 } finally {await isolated.close();}
},60000);

it('owner settings retain business-name updates but cannot transfer ownership branches or cascade history deletion', async () => {
 const p=(await db.query<{name:boolean;owner:boolean;branch:boolean;del:boolean}>("SELECT has_column_privilege('authenticated','public.businesses','name','UPDATE') AS name,has_column_privilege('authenticated','public.businesses','owner_id','UPDATE') AS owner,has_column_privilege('authenticated','public.branches','business_id','UPDATE') AS branch,has_table_privilege('authenticated','public.businesses','DELETE') AS del")).rows[0];
 expect(p).toEqual({name:true,owner:false,branch:false,del:false});
});

it('refunds use immutable sale identity after current catalog metadata changes', async () => {
 await commit(receipt());await commit(sale());await db.exec("UPDATE products SET barcode='renamed',name='New name',is_active=false");
 await commit(refund());expect(await stock()).toBe(5);expect((await db.query('SELECT * FROM refund_items')).rows).toHaveLength(1);
});
it('stop-writes rollback preserves stock immutable history and every success ledger row', async () => {
 await commit(receipt());await commit(sale());await commit(refund());
 const tables=['products','sales','sale_items','refunds','refund_items','pos_v2_operations'];const before=await Promise.all(tables.map(t=>db.query(`SELECT * FROM ${t} ORDER BY id`,[]).catch(()=>db.query(`SELECT * FROM ${t} ORDER BY operation_id`))));
 await db.exec("SET pos.rollback_approved='yes'");
 try {
 await db.exec(readFileSync('database-docs/pos_sync_v2_rollback_review.sql','utf8'));
 await db.exec('SET ROLE authenticated');await expect(commit(receipt('blocked'))).rejects.toThrow('permission');await db.exec('RESET ROLE');
 const after=await Promise.all(tables.map(t=>db.query(`SELECT * FROM ${t} ORDER BY id`,[]).catch(()=>db.query(`SELECT * FROM ${t} ORDER BY operation_id`))));expect(after.map(r=>r.rows)).toEqual(before.map(r=>r.rows));
 } finally {await db.exec('RESET ROLE');await db.exec(migration);}
});

it('an incompatible existing v2 schema aborts without altering historical records', async () => {
 const isolated=new PGlite();try {
 await isolated.exec(liveShapeFixture);await isolated.exec("CREATE TABLE pos_v2_operations(operation_id text PRIMARY KEY,business_id uuid NOT NULL,branch_id uuid NOT NULL,request text NOT NULL,result jsonb NOT NULL,succeeded_at timestamptz NOT NULL)");
 const before=(await isolated.query('SELECT * FROM businesses')).rows;
 await expect(isolated.exec(migration)).rejects.toThrow('Incompatible v2 schema');await isolated.exec('ROLLBACK');
 expect((await isolated.query('SELECT * FROM businesses')).rows).toEqual(before);
 expect((await isolated.query<{t:string}>("SELECT format_type(atttypid,atttypmod) AS t FROM pg_attribute WHERE attrelid='pos_v2_operations'::regclass AND attname='request'")).rows[0].t).toBe('text');
 }finally{await isolated.close();}
},60000);
it('all inventory metadata and adjustment operations require a post-cutover timestamp', async () => {
 await commit(receipt());
 await expect(commit({protocolRevision:3,createdAt:'2020-01-01',operationId:'old-adjustment',businessId:business,branchId:branch,type:'stock_delta',productId:'product-1',quantityDelta:2})).rejects.toThrow('predates');expect(await stock()).toBe(5);
});

it('service API keys cannot bypass the transaction protocol with direct mutations', async () => {
 await commit(receipt());await db.exec('SET ROLE service_role');await expect(db.exec('UPDATE products SET stock=999')).rejects.toThrow('permission');await expect(db.exec('DELETE FROM sales')).rejects.toThrow('permission');await expect(commit(sale())).rejects.toThrow('permission');
});

it('SQL snapshots include inventory beyond 1000 rows without REST pagination truncation', async () => {
 await db.exec(`INSERT INTO products(id,business_id,branch_id,barcode,name,cost,price,stock,is_active) SELECT 'qa-'||g,'${business}','${branch}','qa-barcode-'||g,'Synthetic QA',2,4,1,true FROM generate_series(1,1101) g`);
 const dash=(await db.query<{s:{products:unknown[]}}>('SELECT pos_dashboard_snapshot($1,$2::uuid[]) AS s',[business,[branch]])).rows[0].s;
 const pos=(await db.query<{s:{products:unknown[]}}>('SELECT pos_branch_snapshot($1,$2) AS s',[business,branch])).rows[0].s;
 expect(dash.products).toHaveLength(1101);expect(pos.products).toHaveLength(1101);
});

it('records the signed cloud owner as acknowledger rather than trusting caller-supplied actor metadata', async () => {
 await commit({...receipt(),acknowledged_by:other});
 const row=(await db.query<{acknowledged_by:string}>('SELECT acknowledged_by FROM pos_v2_operations')).rows[0];expect(row.acknowledged_by).toBe(owner);
});
it('read-only post-migration queries run locally and detect normalized financial drift', async () => {
 await commit(receipt());await commit(sale());await commit(refund());
 const validation=readFileSync('database-docs/pos_sync_v2_validate_readonly.sql','utf8');
 const results=await db.exec(validation);
 expect(results.find(r=>r.fields.some(f=>f.name==='incompatible_sale'))?.rows).toEqual([]);
 await db.exec("UPDATE sales SET total=999 WHERE id='sale-1'");
 const changed=await db.exec(validation);
 expect(changed.find(r=>r.fields.some(f=>f.name==='incompatible_sale'))?.rows).toEqual([{incompatible_sale:'sale-1'}]);
});

it('multi-receipt cloud refund commits every child and retries atomically', async () => {
 await commit(receipt());await commit(sale());await commit(sale('sale-2'));
 const second={...refund('refund-2').refund,saleId:'sale-2'};
 const batch={protocolRevision:3,operationId:'batch-1',businessId:business,branchId:branch,type:'refund_batch',refunds:[refund().refund,second]};
 await commit(batch);await commit(batch);expect(await stock()).toBe(5);
 expect((await db.query('SELECT * FROM refunds')).rows).toHaveLength(2);expect((await db.query('SELECT * FROM refund_items')).rows).toHaveLength(2);
});
it('a late refund-batch conflict rolls back earlier refunds stock and success-ledger entries', async () => {
 await commit(receipt());await commit(sale());await commit(sale('sale-2'));const before=(await db.query('SELECT * FROM pos_v2_operations ORDER BY operation_id')).rows;
 const bad={...refund('refund-2',2).refund,saleId:'sale-2'};
 await expect(commit({protocolRevision:3,operationId:'batch-conflict',businessId:business,branchId:branch,type:'refund_batch',refunds:[refund().refund,bad]})).rejects.toThrow('exceeds');
 expect(await stock()).toBe(3);expect((await db.query('SELECT * FROM refunds')).rows).toEqual([]);expect((await db.query('SELECT * FROM pos_v2_operations ORDER BY operation_id')).rows).toEqual(before);
});
it('duplicate refund IDs cannot make a batch acknowledge extra unwritten refunds', async () => {
 await commit(receipt());await commit(sale());await expect(commit({protocolRevision:3,operationId:'batch-duplicate',businessId:business,branchId:branch,type:'refund_batch',refunds:[refund().refund,refund().refund]})).rejects.toThrow('Duplicate refund');expect(await stock()).toBe(4);
});

it('atomic product adjustments roll back stock when catalog validation fails',async()=>{await commit(receipt());const op={protocolRevision:3,createdAt:'2026-10-01T10:00:00Z',operationId:'adjust',businessId:business,branchId:branch,type:'product_adjust',productId:'product-1',quantityDelta:2,updates:{salePrice:-1}};const before=(await db.query('SELECT * FROM pos_v2_operations')).rows;await expect(commit(op)).rejects.toThrow('price');expect(await stock()).toBe(5);expect((await db.query('SELECT * FROM pos_v2_operations')).rows).toEqual(before);await commit({...op,updates:{salePrice:6}});await commit({...op,updates:{salePrice:6}});expect(await stock()).toBe(7);expect((await db.query<{price:string}>('SELECT price FROM products')).rows[0].price).toBe('6');});
it('returns archived products to POS refund catalog but excludes them from Dashboard inventory',async()=>{await commit(receipt());await db.exec("UPDATE products SET is_active=false");const pos=(await db.query<{snapshot:{products:unknown[]}}>(`SELECT pos_branch_snapshot('${business}','${branch}') AS snapshot`)).rows[0].snapshot;expect(pos.products).toEqual([expect.objectContaining({id:'product-1',isActive:false})]);const dashboard=(await db.query<{snapshot:{products:unknown[]}}>(`SELECT pos_dashboard_snapshot('${business}',ARRAY['${branch}']::uuid[]) AS snapshot`)).rows[0].snapshot;expect(dashboard.products).toEqual([]);});
it('rejects null prices instead of silently accepting unchanged catalog',async()=>{await commit(receipt());await expect(commit({protocolRevision:3,createdAt:'2026-10-01T10:00:00Z',operationId:'null-price',businessId:business,branchId:branch,type:'product_update',productId:'product-1',updates:{salePrice:null}})).rejects.toThrow('null');});

it('read-only reconciliation diagnostics flag synthetic historical defects without changing records',async()=>{await commit(receipt());await db.exec(`INSERT INTO products(id,business_id,branch_id,barcode,name,cost,price,stock,is_active) VALUES('negative-qa','${business}','${branch}','negative-qa','Synthetic',2,4,-2,true);INSERT INTO sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date) VALUES('incomplete-qa','${business}','${branch}',8,8,'USD',89500,'QA','2026-10-01T10:00:00Z')`);const before=(await db.query('SELECT * FROM products ORDER BY id')).rows;const report=(await db.query<{reconciliation_summary:{negative_products:number;sales_without_items:number;legacy_ledger_present:boolean}}>(readFileSync('database-docs/historical_reconciliation_readonly.sql','utf8'))).rows[0].reconciliation_summary;expect(report.negative_products).toBe(1);expect(report.sales_without_items).toBe(1);expect(report.legacy_ledger_present).toBe(true);expect((await db.query('SELECT * FROM products ORDER BY id')).rows).toEqual(before);});
