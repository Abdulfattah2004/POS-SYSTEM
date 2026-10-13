// @vitest-environment node
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {databaseFixture} from '../test/databaseFixture';
const business='1593a757-910c-4e45-8dd2-26436bae0347',branch='64bb012f-4070-4ef8-87b7-a3f836e522a9',owner='33333333-3333-3333-3333-333333333333';

it('read-only deployment preflight preserves original data before and after the exact reviewed migration',async()=>{
 const db=new PGlite();
 try {
  await db.exec(databaseFixture(business,branch,owner));
  await db.exec(`INSERT INTO products(id,business_id,branch_id,name,stock) VALUES('preserved','${business}','${branch}','Preserved',-4)`);
  const before=(await db.query('SELECT to_jsonb(p) AS row FROM products p')).rows;
  const script=readFileSync('database-docs/pos_sync_v2_preflight_readonly.sql','utf8');
  await db.exec(script);
  expect((await db.query('SELECT to_jsonb(p) AS row FROM products p')).rows).toEqual(before);
  expect((await db.query("SELECT to_regclass('public.pos_v2_operations') AS ledger")).rows[0]).toEqual({ledger:null});
  await db.exec(readFileSync('database-docs/pos_sync_v2_review.sql','utf8'));
  await db.exec(script);
  expect((await db.query('SELECT to_jsonb(p) AS row FROM products p')).rows).toEqual(before);
  expect((await db.query('SELECT * FROM pos_v2_operations')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM pos_v2_branch_gate WHERE writes_enabled')).rows).toHaveLength(0);
 }finally{await db.close();}
},60000);

it('protected reconciliation export includes null-scoped child history and excludes other businesses without mutations',async()=>{
 const db=new PGlite();
 try {
  await db.exec(databaseFixture(business,branch,owner));
  await db.exec(`INSERT INTO businesses VALUES('99999999-9999-9999-9999-999999999999','${owner}','Other');
   INSERT INTO products(id,business_id,branch_id,name,stock) VALUES('own','${business}','${branch}','Own',7),('foreign','99999999-9999-9999-9999-999999999999',null,'Foreign',100);
   INSERT INTO sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date) VALUES('sale','${business}','${branch}',8,8,'USD',89500,'QA','2026-10-06');
   INSERT INTO sale_items(id,sale_id,product_id,quantity) VALUES('legacy-child','sale','own',1);`);
  const results=await db.exec(readFileSync('database-docs/pos_reconciliation_export_readonly.sql','utf8'));
  const row=results.flatMap(result=>result.rows).find(record=>'protected_reconciliation_export' in record);
  const snapshot=row?.protected_reconciliation_export as {products:{id:string;stock:number}[];sale_items:{id:string;business_id:null}[];sales:{id:string}[]};
  expect(snapshot.products.map(product=>product.id)).toEqual(['own']);
  expect(snapshot.products[0].stock).toBe(7);
  expect(snapshot.sale_items).toHaveLength(1);
  expect(snapshot.sale_items[0].business_id).toBeNull();
  expect(snapshot.sales.map(sale=>sale.id)).toEqual(['sale']);
  expect((await db.query('SELECT stock FROM products WHERE id=\'foreign\'')).rows[0]).toEqual({stock:100});
 }finally{await db.close();}
},60000);
