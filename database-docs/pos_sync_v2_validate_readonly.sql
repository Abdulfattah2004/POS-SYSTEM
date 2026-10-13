-- READ ONLY. For a separately approved staging/production validation session.
-- Statements 1-3 also work before migration. Statements 4-7 require v2 tables.
-- No functions below mutate data; no application synchronization is invoked.

-- 1. Core baseline. Export before and immediately after migration while all
-- writers are paused. Counts/digests must match exactly; this is not a backup.
SELECT 'products' AS relation,count(*) AS rows,md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) AS logical_digest FROM public.products t
UNION ALL SELECT 'inventory_entries',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.inventory_entries t
UNION ALL SELECT 'sales',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.sales t
UNION ALL SELECT 'sale_items',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.sale_items t
UNION ALL SELECT 'refunds',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.refunds t
UNION ALL SELECT 'refund_items',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.refund_items t;

-- 2. Stock issues remain visible; never normalize negative/null values here.
SELECT business_id,branch_id,count(*) AS products,sum(stock) AS stock_sum,
 count(*) FILTER(WHERE stock<0) AS negative_stock,
 count(*) FILTER(WHERE stock IS NULL) AS unknown_stock,
 count(*) FILTER(WHERE is_active IS TRUE AND branch_id IS NULL) AS unallocated_active_products
FROM public.products GROUP BY business_id,branch_id ORDER BY business_id,branch_id;

-- 3. Existing ledger metadata only: absence is not proof that past movements
-- are pending. Use the original read-only ledger inspection for any present
-- variant, and compare a protected full row export without changing history.
SELECT to_regclass('public.inventory_sync_operations') AS legacy_ledger;
SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
FROM pg_attribute a WHERE a.attrelid=to_regclass('public.inventory_sync_operations')
AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum;

-- 4. No enabled gate is expected immediately after first installation.
SELECT business_id,branch_id,writes_enabled,cutover_at,reviewed_by
FROM public.pos_v2_branch_gate ORDER BY business_id,branch_id;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname IN ('pos_v2_operations','pos_v2_sales','pos_v2_refunds','pos_v2_branch_gate');
SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit
FROM pg_roles WHERE rolname='pos_v2_executor';
SELECT parent.rolname AS role,member.rolname AS member,m.admin_option,m.inherit_option,m.set_option
FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
WHERE parent.rolname='pos_v2_executor' OR member.rolname='pos_v2_executor';
SELECT p.proname,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'pos_%';
SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;

-- 5. Direct mutation privileges must be false for all three API roles.
SELECT r.rolname,t.table_name,
 has_table_privilege(r.rolname,'public.'||t.table_name,'INSERT') AS can_insert,
 has_table_privilege(r.rolname,'public.'||t.table_name,'UPDATE') AS can_update,
 has_table_privilege(r.rolname,'public.'||t.table_name,'DELETE') AS can_delete,
 has_table_privilege(r.rolname,'public.'||t.table_name,'TRUNCATE') AS can_truncate
FROM pg_roles r CROSS JOIN (VALUES('products'),('inventory_entries'),('sales'),('sale_items'),('refunds'),('refund_items'),('pos_v2_operations'),('pos_v2_sales'),('pos_v2_refunds'),('pos_v2_branch_gate')) t(table_name)
WHERE r.rolname IN ('anon','authenticated','service_role') ORDER BY r.rolname,t.table_name;
SELECT has_column_privilege('authenticated','public.businesses','name','UPDATE') AS owner_name_update,
 has_column_privilege('authenticated','public.businesses','owner_id','UPDATE') AS owner_transfer,
 has_column_privilege('authenticated','public.branches','business_id','UPDATE') AS branch_reassignment;

-- 6. All lists below must be empty for NEW verified records only. Existing
-- incomplete historical rows are not silently repaired or folded into totals.
SELECT v.id AS incompatible_sale FROM public.pos_v2_sales v LEFT JOIN public.sales s ON s.id=v.id
WHERE s.id IS NULL OR s.business_id IS DISTINCT FROM v.business_id OR s.branch_id IS DISTINCT FROM v.branch_id
 OR s.total IS DISTINCT FROM (v.record->>'total')::numeric OR s.subtotal IS DISTINCT FROM (v.record->>'subtotal')::numeric
 OR s.currency IS DISTINCT FROM v.record->>'currency' OR s.exchange_rate IS DISTINCT FROM (v.record->>'exchangeRate')::numeric
 OR s.date IS DISTINCT FROM v.record->>'date' OR s.cashier_name IS DISTINCT FROM v.record->>'cashierName'
 OR (SELECT count(*) FROM public.sale_items i WHERE i.sale_id=v.id)<>jsonb_array_length(v.record->'items');
SELECT v.id AS incompatible_refund FROM public.pos_v2_refunds v LEFT JOIN public.refunds r ON r.id=v.id
WHERE r.id IS NULL OR r.business_id IS DISTINCT FROM v.business_id OR r.branch_id IS DISTINCT FROM v.branch_id
 OR r.sale_id IS DISTINCT FROM v.sale_id OR r.total_refunded IS DISTINCT FROM (v.record->>'totalRefunded')::numeric
 OR r.currency IS DISTINCT FROM v.record->>'currency' OR r.date IS DISTINCT FROM v.record->>'date'
 OR r.cashier_name IS DISTINCT FROM v.record->>'cashierName'
 OR (SELECT count(*) FROM public.refund_items i WHERE i.refund_id=v.id)<>jsonb_array_length(v.record->'items');
SELECT v.id,i->>'productId' AS incompatible_sale_line FROM public.pos_v2_sales v CROSS JOIN LATERAL jsonb_array_elements(v.record->'items') i
WHERE NOT EXISTS(SELECT 1 FROM public.sale_items s WHERE s.sale_id=v.id AND s.business_id=v.business_id AND s.branch_id=v.branch_id
 AND s.product_id=i->>'productId' AND s.quantity=(i->>'quantity')::integer AND s.sale_price=(i->>'salePrice')::numeric AND s.purchase_price=(i->>'purchasePrice')::numeric AND s.barcode=i->>'barcode' AND s.product_name=i->>'productName' AND s.currency=i->>'currency');
SELECT v.id,i->>'productId' AS incompatible_refund_line FROM public.pos_v2_refunds v CROSS JOIN LATERAL jsonb_array_elements(v.record->'items') i
WHERE NOT EXISTS(SELECT 1 FROM public.refund_items r WHERE r.refund_id=v.id AND r.business_id=v.business_id AND r.branch_id=v.branch_id
 AND r.product_id=i->>'productId' AND r.quantity=(i->>'quantity')::integer AND r.sale_price=(i->>'salePrice')::numeric AND r.purchase_price=(i->>'purchasePrice')::numeric AND r.barcode=i->>'barcode' AND r.product_name=i->>'productName' AND r.currency=i->>'currency');
SELECT s.id,i->>'productId' AS excessive_verified_refund FROM public.pos_v2_sales s CROSS JOIN LATERAL jsonb_array_elements(s.record->'items') i
WHERE (SELECT coalesce(sum((ri->>'quantity')::integer),0) FROM public.pos_v2_refunds r CROSS JOIN LATERAL jsonb_array_elements(r.record->'items') ri WHERE r.sale_id=s.id AND ri->>'productId'=i->>'productId')>(i->>'quantity')::integer;

-- 7. Ledger health: every success must bind the exact recorded scope/ID.
SELECT operation_id FROM public.pos_v2_operations
WHERE request->>'operationId' IS DISTINCT FROM operation_id
 OR request->>'businessId' IS DISTINCT FROM business_id::text
 OR request->>'branchId' IS DISTINCT FROM branch_id::text
 OR result->>'operation_id' IS DISTINCT FROM operation_id
 OR result->>'confirmed' IS DISTINCT FROM 'true';
