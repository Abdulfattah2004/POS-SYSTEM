// @vitest-environment node
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

// Catalog definitions only: no production business rows or credentials are copied.
const catalog = JSON.parse(readFileSync('database-docs/live-inspection/20261005_contract_shape.json', 'utf8')) as {
  columns: { table: string; column: string; type: string; nullable: boolean }[];
  constraints: { table: string; definition: string }[];
};
const identifier = (value: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error('Unexpected catalog identifier');
  return `"${value}"`;
};

it('installs and reapplies against inspected production column/constraint shapes without changing synthetic legacy history', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;`);
    for (const table of new Set(catalog.columns.map(column => column.table))) {
      const columns = catalog.columns.filter(column => column.table === table).map(column => {
        if (!/^(text|uuid|boolean|integer|numeric|timestamp with time zone)$/.test(column.type)) throw new Error('Unexpected catalog type');
        return `${identifier(column.column)} ${column.type}${column.nullable ? '' : ' NOT NULL'}`;
      });
      await db.exec(`CREATE TABLE public.${identifier(table)} (${columns.join(',')}); ALTER TABLE public.${identifier(table)} ENABLE ROW LEVEL SECURITY;`);
    }
    // Catalog order is unspecified; referenced unique keys must precede FKs.
    for (const constraint of [...catalog.constraints].sort((a,b) => Number(a.definition.startsWith('FOREIGN KEY'))-Number(b.definition.startsWith('FOREIGN KEY')))) {
      const table = constraint.table.replace(/^public\./, '');
      await db.exec(`ALTER TABLE public.${identifier(table)} ADD ${constraint.definition};`);
    }
    await db.exec(`INSERT INTO auth.users VALUES('11111111-1111-4111-8111-111111111111');
      INSERT INTO businesses(id,owner_id,name) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic preserved shop');
      INSERT INTO branches(id,business_id,name) VALUES('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','Synthetic branch');
      INSERT INTO products(id,business_id,branch_id,name,price,stock) VALUES('negative','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','Synthetic negative',4,-2);
      INSERT INTO sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date)
        VALUES('incomplete-history','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',8,8,'USD',90000,'Synthetic','2020-01-01T12:00:00Z');
      SET pos.review_approved='yes';`);
    const before = await db.query('SELECT to_jsonb(p) AS record FROM products p UNION ALL SELECT to_jsonb(s) FROM sales s');
    const migration = readFileSync('database-docs/pos_sync_v2_review.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query('SELECT to_jsonb(p) AS record FROM products p UNION ALL SELECT to_jsonb(s) FROM sales s')).rows).toEqual(before.rows);
    expect((await db.query('SELECT * FROM pos_v2_operations')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM pos_v2_branch_gate')).rows).toEqual([]);
    expect((await db.query("SELECT to_regclass('public.inventory_sync_operations') AS ledger")).rows).toEqual([{ ledger: null }]);
    expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','products','UPDATE') AS allowed")).rows[0].allowed).toBe(false);
  } finally { await db.close(); }
}, 30000);
