-- SELECT-only snapshot. No baseline adoption, queue replay or gate activation.
-- Run in the existing project through a protected DBA/read-only connection.
BEGIN READ ONLY;
SET LOCAL statement_timeout='60s';
SELECT now() AS observed_at,current_user,current_setting('transaction_read_only') AS transaction_read_only,version();
SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname IN ('public','auth','supabase_migrations') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname;
SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position;
SELECT conrelid::regclass AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conrelid::regclass::text,conname;
SELECT p.oid::regprocedure AS signature,pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig,p.proacl,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' ORDER BY p.oid::regprocedure::text;
SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;
SELECT table_name,grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' ORDER BY table_name,grantee,privilege_type;
SELECT rolname,rolsuper,rolbypassrls,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit FROM pg_roles ORDER BY rolname;
SELECT parent.rolname AS role,member.rolname AS member,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member ORDER BY parent.rolname,member.rolname;
SELECT tgrelid::regclass AS relation,tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace) ORDER BY tgrelid::regclass::text,tgname;
SELECT pubname,puballtables,pubinsert,pubupdate,pubdelete,pubtruncate FROM pg_publication ORDER BY pubname;
SELECT pubname,schemaname,tablename FROM pg_publication_tables ORDER BY pubname,schemaname,tablename;
SELECT to_regclass('supabase_migrations.schema_migrations') AS migration_history,to_regclass('public.inventory_sync_operations') AS legacy_ledger,to_regclass('public.pos_v2_operations') AS v2_ledger,to_regprocedure('public.pos_dashboard_snapshot(uuid,uuid[])') AS dashboard_rpc;
-- Counts/digests are evidence only, never a backup or authority for quantities.
SELECT 'products' AS relation,count(*) AS rows,md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) AS logical_digest FROM public.products t
UNION ALL SELECT 'inventory_entries',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.inventory_entries t
UNION ALL SELECT 'sales',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.sales t
UNION ALL SELECT 'sale_items',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.sale_items t
UNION ALL SELECT 'refunds',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.refunds t
UNION ALL SELECT 'refund_items',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\n' ORDER BY id),'')) FROM public.refund_items t;
COMMIT;
-- After checking existence/permissions, separately export migration history and
-- each present legacy/v2 ledger into protected evidence. Do not query absent
-- variants or reinterpret an unknown ledger schema as a successful operation.
-- Provider Auth settings, external storage objects and backup/PITR recoverability
-- require management access; pg_catalog inspection does not prove them.
