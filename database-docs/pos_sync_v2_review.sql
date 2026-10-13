-- REVIEW ONLY. Never run on production without explicit approval.
-- Additive protocol: leaves all existing inventory/sales/refunds and successful
-- inventory_sync_operations rows intact. No stock is reset or backfilled.
-- In a reviewed staging session only: SET pos.review_approved = 'yes';
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$
DECLARE ledger_column text;
BEGIN
  IF current_setting('pos.review_approved', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Review and explicitly approve this migration before execution';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_v2_executor') THEN
    CREATE ROLE pos_v2_executor NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pos_v2_executor' AND (rolsuper OR rolbypassrls OR rolcanlogin OR rolcreaterole OR rolcreatedb OR rolinherit))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'pos_v2_executor') AND (member <> (SELECT oid FROM pg_roles WHERE rolname=session_user) OR inherit_option OR set_option)) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='pos_v2_executor')) THEN
    RAISE EXCEPTION 'Unsafe executor role configuration';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.businesses'::regclass, 'public.branches'::regclass, 'public.products'::regclass, 'public.inventory_entries'::regclass,'public.sales'::regclass,'public.sale_items'::regclass,'public.refunds'::regclass,'public.refund_items'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'Existing business tables must have RLS enabled before review';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.products'::regclass,'public.inventory_entries'::regclass,'public.sales'::regclass,'public.sale_items'::regclass,'public.refunds'::regclass,'public.refund_items'::regclass)) THEN RAISE EXCEPTION 'Unexpected existing transaction triggers require review before migration'; END IF;
  IF to_regclass('public.inventory_sync_operations') IS NOT NULL THEN
    FOREACH ledger_column IN ARRAY ARRAY['operation_id','business_id','branch_id','product_id','quantity_delta'] LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.inventory_sync_operations') AND attname=ledger_column AND NOT attisdropped) THEN RAISE EXCEPTION 'Unsupported legacy ledger: missing %. Preserve ledger and prepare an explicit adapter.',ledger_column; END IF;
    END LOOP;
  END IF;
END;
$$;

-- Separate immutable ledger avoids altering any incompatible legacy ledger.
CREATE TABLE IF NOT EXISTS public.pos_v2_operations (
  operation_id text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  succeeded_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid NOT NULL DEFAULT auth.uid()
);
CREATE TABLE IF NOT EXISTS public.pos_v2_sales (
  id text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.pos_v2_refunds (
  id text PRIMARY KEY,
  sale_id text NOT NULL REFERENCES public.pos_v2_sales(id),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- CREATE IF NOT EXISTS must never silently accept an incompatible variant.
DO $$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES
 ('pos_v2_operations','operation_id','text'),('pos_v2_operations','business_id','uuid'),('pos_v2_operations','branch_id','uuid'),('pos_v2_operations','request','jsonb'),('pos_v2_operations','result','jsonb'),('pos_v2_operations','succeeded_at','timestamp with time zone'),('pos_v2_operations','acknowledged_by','uuid'),
 ('pos_v2_sales','id','text'),('pos_v2_sales','business_id','uuid'),('pos_v2_sales','branch_id','uuid'),('pos_v2_sales','record','jsonb'),('pos_v2_sales','created_at','timestamp with time zone'),
 ('pos_v2_refunds','id','text'),('pos_v2_refunds','sale_id','text'),('pos_v2_refunds','business_id','uuid'),('pos_v2_refunds','branch_id','uuid'),('pos_v2_refunds','record','jsonb'),('pos_v2_refunds','created_at','timestamp with time zone')
 ) AS v(table_name,column_name,data_type) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||expected.table_name) AND a.attname=expected.column_name AND NOT a.attisdropped AND a.attnotnull AND format_type(a.atttypid,a.atttypmod)=expected.data_type) THEN RAISE EXCEPTION 'Incompatible v2 schema %.%: preserve existing table and review an adapter',expected.table_name,expected.column_name; END IF;
 END LOOP;
 FOR expected IN SELECT * FROM (VALUES ('pos_v2_operations','operation_id'),('pos_v2_sales','id'),('pos_v2_refunds','id')) AS v(table_name,column_name) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname=expected.column_name WHERE c.conrelid=to_regclass('public.'||expected.table_name) AND c.contype='p' AND c.conkey=ARRAY[a.attnum]::smallint[]) THEN RAISE EXCEPTION 'Incompatible v2 primary key on %',expected.table_name; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename IN ('pos_v2_operations','pos_v2_sales','pos_v2_refunds') AND policyname NOT IN ('pos_v2_executor_pos_v2_operations','pos_v2_executor_pos_v2_sales','pos_v2_executor_pos_v2_refunds','pos_v2_owner_read')) THEN RAISE EXCEPTION 'Unknown existing v2 policies require review'; END IF;
END $$;
ALTER TABLE public.pos_v2_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_sales FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_refunds FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS pos_v2_sales_scope ON public.pos_v2_sales(business_id, branch_id);
CREATE INDEX IF NOT EXISTS pos_v2_refunds_scope ON public.pos_v2_refunds(business_id, branch_id, sale_id);

-- Dedicated policies target only the new executor role. Existing policies stay.
DO $$
DECLARE t text; policy_name text;
BEGIN
  FOREACH t IN ARRAY ARRAY['businesses','branches','products','inventory_entries','sales','sale_items','refunds','refund_items','pos_v2_operations','pos_v2_sales','pos_v2_refunds'] LOOP
    policy_name := 'pos_v2_executor_' || t;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname=policy_name) THEN
      IF t = 'businesses' THEN
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO pos_v2_executor USING (owner_id = auth.uid())',policy_name,t);
      ELSE
        EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO pos_v2_executor USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = %I.business_id AND b.owner_id = auth.uid())) WITH CHECK (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = %I.business_id AND b.owner_id = auth.uid()))',policy_name,t,t,t);
      END IF;
    END IF;
  END LOOP;
  -- Reapply trusted executor scope expressions rather than keeping a stale
  -- policy solely because its name already exists.
  FOREACH t IN ARRAY ARRAY['businesses','branches','products','inventory_entries','sales','sale_items','refunds','refund_items','pos_v2_operations','pos_v2_sales','pos_v2_refunds'] LOOP
    policy_name := 'pos_v2_executor_' || t;
    IF t='businesses' THEN
      EXECUTE format('ALTER POLICY %I ON public.%I TO pos_v2_executor USING (owner_id=auth.uid())',policy_name,t);
    ELSE
      EXECUTE format('ALTER POLICY %I ON public.%I TO pos_v2_executor USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=%I.business_id AND b.owner_id=auth.uid())) WITH CHECK (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=%I.business_id AND b.owner_id=auth.uid()))',policy_name,t,t,t);
    END IF;
  END LOOP;
  IF to_regclass('public.inventory_sync_operations') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='inventory_sync_operations' AND policyname='pos_v2_legacy_ledger_read') THEN
      EXECUTE 'CREATE POLICY pos_v2_legacy_ledger_read ON public.inventory_sync_operations FOR SELECT TO pos_v2_executor USING (EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = inventory_sync_operations.business_id AND b.owner_id = auth.uid()))';
    END IF;
    REVOKE ALL ON public.inventory_sync_operations FROM PUBLIC,anon,authenticated,service_role;
    GRANT SELECT ON public.inventory_sync_operations TO pos_v2_executor;
  END IF;
END;
$$;
GRANT USAGE ON SCHEMA public TO pos_v2_executor;
-- The managed DBA has auth USAGE without grant option. Do not attempt to
-- delegate managed schema privileges: PostgreSQL can warn and grant nothing.
-- Existing RLS/default expressions already bind auth.uid() by OID. The RPC
-- identity adapter below also binds that exact function at creation time.
GRANT SELECT ON public.businesses, public.branches, public.products, public.inventory_entries, public.sales, public.sale_items, public.refunds, public.refund_items TO pos_v2_executor;
GRANT INSERT ON public.sales, public.sale_items, public.refunds, public.refund_items TO pos_v2_executor;
GRANT INSERT, UPDATE ON public.products TO pos_v2_executor;
GRANT INSERT, UPDATE ON public.inventory_entries TO pos_v2_executor;
GRANT SELECT, INSERT ON public.pos_v2_operations, public.pos_v2_sales, public.pos_v2_refunds TO pos_v2_executor;
-- SELECT FOR UPDATE needs UPDATE privilege; no financial record column is writable.
GRANT UPDATE (id) ON public.pos_v2_sales TO pos_v2_executor;
REVOKE ALL ON public.pos_v2_operations, public.pos_v2_sales, public.pos_v2_refunds FROM PUBLIC, anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO pos_v2_executor;

-- Installation alone never activates writes. Enable a synthetic staging branch
-- separately; production activation requires explicit deployment approval.
CREATE TABLE IF NOT EXISTS public.pos_v2_branch_gate (
 business_id uuid NOT NULL REFERENCES public.businesses(id),
 branch_id uuid PRIMARY KEY REFERENCES public.branches(id),
 writes_enabled boolean NOT NULL DEFAULT false,
 cutover_at timestamptz NOT NULL,
 reviewed_by text NOT NULL CHECK (length(btrim(reviewed_by))>0)
);
-- Branch policy is server-owned. Installing this migration never enables
-- synchronization or negative-stock fulfillment for any production branch.
ALTER TABLE public.pos_v2_branch_gate ADD COLUMN IF NOT EXISTS allow_negative_stock boolean NOT NULL DEFAULT false;
DO $$ DECLARE expected record; BEGIN
 FOR expected IN SELECT * FROM (VALUES('business_id','uuid'),('branch_id','uuid'),('writes_enabled','boolean'),('cutover_at','timestamp with time zone'),('reviewed_by','text'),('allow_negative_stock','boolean')) AS v(column_name,data_type) LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.pos_v2_branch_gate'::regclass AND a.attname=expected.column_name AND NOT a.attisdropped AND a.attnotnull AND format_type(a.atttypid,a.atttypmod)=expected.data_type) THEN RAISE EXCEPTION 'Incompatible branch gate column %; review existing cutover state',expected.column_name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='branch_id' WHERE c.conrelid='public.pos_v2_branch_gate'::regclass AND c.contype='p' AND c.conkey=ARRAY[a.attnum]::smallint[]) THEN RAISE EXCEPTION 'Incompatible branch gate primary key'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pos_v2_branch_gate' AND policyname<>'pos_v2_gate_read') OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.pos_v2_branch_gate'::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Unexpected branch gate policy or trigger requires review'; END IF;
END $$;
ALTER TABLE public.pos_v2_branch_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_v2_branch_gate FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='pos_v2_branch_gate' AND policyname='pos_v2_gate_read') THEN
 CREATE POLICY pos_v2_gate_read ON public.pos_v2_branch_gate FOR SELECT TO pos_v2_executor USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=business_id AND b.owner_id=auth.uid()));
 END IF;
 ALTER POLICY pos_v2_gate_read ON public.pos_v2_branch_gate TO pos_v2_executor USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=pos_v2_branch_gate.business_id AND b.owner_id=auth.uid()));
END $$;
REVOKE ALL ON public.pos_v2_branch_gate FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.pos_v2_branch_gate TO pos_v2_executor;
-- Block unguarded client mutations; keep owner reads and business-name settings.
REVOKE ALL ON public.products,public.inventory_entries,public.sales,public.sale_items,public.refunds,public.refund_items FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.products,public.inventory_entries,public.sales,public.sale_items,public.refunds,public.refund_items TO authenticated,service_role;
REVOKE ALL ON public.businesses,public.branches FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.businesses,public.branches TO authenticated,service_role;
-- The Dashboard only edits a business display name. Ownership and branch
-- reassignment must remain privileged, reviewed administrative operations.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT t.relname,a.attname FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid WHERE n.nspname='public' AND t.relname IN ('businesses','branches','products','inventory_entries','sales','sale_items','refunds','refund_items','pos_v2_operations','pos_v2_sales','pos_v2_refunds','pos_v2_branch_gate') AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL LOOP
 EXECUTE format('REVOKE SELECT(%I),INSERT(%I),UPDATE(%I),REFERENCES(%I) ON public.%I FROM PUBLIC,anon,authenticated,service_role',c.attname,c.attname,c.attname,c.attname,c.relname);
 END LOOP;
END $$;
GRANT UPDATE(name) ON public.businesses TO authenticated;
GRANT SELECT ON public.pos_v2_sales,public.pos_v2_refunds TO authenticated;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pos_v2_sales','pos_v2_refunds'] LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=t AND policyname='pos_v2_owner_read') THEN
 EXECUTE format('CREATE POLICY pos_v2_owner_read ON public.%I FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=business_id AND b.owner_id=auth.uid()))',t);
 END IF;
 EXECUTE format('ALTER POLICY pos_v2_owner_read ON public.%I TO authenticated USING (EXISTS(SELECT 1 FROM public.businesses b WHERE b.id=%I.business_id AND b.owner_id=auth.uid()))',t,t);
 END LOOP;
 -- PostgreSQL 17 creators receive ADMIN membership without SET or INHERIT.
 -- SET is temporary for transferring function ownership, never granted to clients.
 EXECUTE format('GRANT pos_v2_executor TO %I WITH SET TRUE, INHERIT FALSE',current_user);
END $$;

DO $$ BEGIN
 IF NOT has_schema_privilege(current_user,'auth','USAGE') OR NOT has_function_privilege('pos_v2_executor','auth.uid()','EXECUTE') THEN
  RAISE EXCEPTION 'Existing Supabase identity permissions require review';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.pos_authenticated_owner_id()') AND (pg_get_userbyid(proowner)<>current_user OR prosecdef)) THEN
  RAISE EXCEPTION 'Unexpected identity adapter ownership/security requires review';
 END IF;
END $$;
-- SQL-standard body resolves the existing auth.uid() OID under the DBA's
-- existing USAGE privilege. SECURITY INVOKER confers no DBA privileges and
-- does not reimplement claims/JWT parsing. Clients cannot execute this helper.
CREATE OR REPLACE FUNCTION public.pos_authenticated_owner_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog
RETURN auth.uid();
REVOKE ALL ON FUNCTION public.pos_authenticated_owner_id() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.pos_authenticated_owner_id() TO pos_v2_executor;

SET LOCAL ROLE pos_v2_executor;

CREATE OR REPLACE FUNCTION public.pos_sync_protocol()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT jsonb_build_object('version', 2, 'revision', 3, 'atomic_refund_batches', true, 'atomic_product_adjustments', true, 'archived_refund_catalog', true, 'ledger_preserved', true) $$;

CREATE OR REPLACE FUNCTION public.pos_commit_operation(p_operation jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
#variable_conflict use_variable
DECLARE
  op text := NULLIF(p_operation->>'operationId','');
  kind text := p_operation->>'type';
  business uuid := (p_operation->>'businessId')::uuid;
  branch uuid := (p_operation->>'branchId')::uuid;
  previous public.pos_v2_operations%ROWTYPE;
  legacy jsonb;
  entry jsonb := p_operation->'entry';
  incoming jsonb := p_operation->'product';
  financial jsonb;
  original jsonb;
  line jsonb;
  original_line jsonb;
  lines jsonb := '[]'::jsonb;
  mappings jsonb := '{}'::jsonb;
  product public.products%ROWTYPE;
  existing_entry public.inventory_entries%ROWTYPE;
  product_id text;
  incoming_id text;
  record_id text;
  sale_id text;
  barcode text;
  qty integer;
  sold integer;
  returned integer;
  delta integer;
  subtotal numeric := 0;
  unit_price numeric;
  unit_cost numeric;
  exchange_rate numeric;
  result jsonb;
  updates jsonb;
  child_result jsonb;
  map_key text;
  resolved_ids text[] := ARRAY[]::text[];
BEGIN
  IF public.pos_authenticated_owner_id() IS NULL OR business IS NULL OR branch IS NULL OR op IS NULL THEN RAISE EXCEPTION 'Authenticated owner and operation scope are required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches br JOIN public.businesses b ON b.id=br.business_id WHERE br.id=branch AND br.business_id=business AND b.owner_id=public.pos_authenticated_owner_id()) THEN RAISE EXCEPTION 'Unauthorized business or branch'; END IF;
  IF kind IS NULL OR kind NOT IN ('receive','stock_delta','sale','refund','refund_batch','product_upsert','product_update','product_adjust','product_delete','inventory_entry_update','inventory_entry_delete') THEN RAISE EXCEPTION 'Unsupported operation type; receipt history cannot be deleted'; END IF;
  -- Serializes all POS operations for this branch, including first product creation.
  PERFORM pg_advisory_xact_lock(hashtextextended('pos-v2:' || business::text || ':' || branch::text,0));
  SELECT * INTO previous FROM public.pos_v2_operations WHERE operation_id=op;
  IF FOUND THEN
    IF previous.business_id<>business OR previous.branch_id<>branch OR previous.request IS DISTINCT FROM p_operation THEN RAISE EXCEPTION 'Operation ID conflicts with a previous immutable request'; END IF;
    RETURN previous.result;
  END IF;

  IF NOT EXISTS(SELECT 1 FROM public.pos_v2_branch_gate g WHERE g.business_id=business AND g.branch_id=branch AND g.writes_enabled) THEN RAISE EXCEPTION 'Branch synchronization is disabled pending approved cutover'; END IF;
  -- Read, never update/delete, successful old ledger records. Never reapply them.
  IF to_regclass('public.inventory_sync_operations') IS NOT NULL THEN
    EXECUTE 'SELECT to_jsonb(o) FROM public.inventory_sync_operations o WHERE operation_id=$1' INTO legacy USING op;
    IF legacy IS NOT NULL THEN
      IF legacy->>'business_id' IS DISTINCT FROM business::text OR legacy->>'branch_id' IS DISTINCT FROM branch::text THEN RAISE EXCEPTION 'Legacy operation scope conflict'; END IF;
      IF legacy ? 'status' AND legacy->>'status' IS DISTINCT FROM 'succeeded' THEN RAISE EXCEPTION 'Legacy operation status requires manual reconciliation; replay is blocked'; END IF;
      IF kind NOT IN ('receive','stock_delta') THEN RAISE EXCEPTION 'Legacy operation type conflict'; END IF;
      qty := CASE WHEN kind='receive' THEN (entry->>'quantityAdded')::integer ELSE (p_operation->>'quantityDelta')::integer END;
      IF (legacy->>'quantity_delta')::integer IS DISTINCT FROM qty OR (legacy ? 'operation_type' AND legacy->>'operation_type' IS DISTINCT FROM kind) THEN RAISE EXCEPTION 'Legacy operation payload conflict'; END IF;
      incoming_id := CASE WHEN kind='receive' THEN entry->>'productId' ELSE p_operation->>'productId' END;
      IF kind='stock_delta' AND incoming_id IS DISTINCT FROM legacy->>'product_id' THEN RAISE EXCEPTION 'Legacy product ID conflict; replay is blocked'; END IF;
      IF kind='receive' THEN
        SELECT * INTO existing_entry FROM public.inventory_entries WHERE id=entry->>'id';
        IF NOT FOUND OR existing_entry.business_id<>business OR existing_entry.branch_id<>branch OR existing_entry.product_id IS DISTINCT FROM legacy->>'product_id' OR existing_entry.barcode IS DISTINCT FROM entry->>'barcode' OR existing_entry.quantity_added IS DISTINCT FROM qty OR existing_entry.purchase_price IS DISTINCT FROM (entry->>'purchasePrice')::numeric OR existing_entry.sale_price IS DISTINCT FROM (entry->>'salePrice')::numeric THEN RAISE EXCEPTION 'Legacy receipt proof requires manual reconciliation; replay is blocked'; END IF;
      END IF;
      mappings := jsonb_build_object(incoming_id,legacy->>'product_id');
      result := jsonb_build_object('operation_id',op,'confirmed',true,'already_processed',true,'product_ids',mappings);
      INSERT INTO public.pos_v2_operations(operation_id,business_id,branch_id,request,result,succeeded_at) VALUES (op,business,branch,p_operation,result,now());
      RETURN result;
    END IF;
  END IF;

  IF p_operation->>'protocolRevision' IS DISTINCT FROM '3' THEN RAISE EXCEPTION 'Pre-cutover operation requires manual reconciliation; replay is blocked'; END IF;
  IF NULLIF(p_operation->>'createdAt','') IS NULL OR (p_operation->>'createdAt')::timestamptz < (SELECT g.cutover_at FROM public.pos_v2_branch_gate g WHERE g.branch_id=branch AND g.business_id=business) THEN RAISE EXCEPTION 'Operation predates approved cutover; automatic replay is blocked'; END IF;
  IF kind IN ('sale','refund','receive') THEN
    IF (CASE kind WHEN 'sale' THEN (p_operation->'sale'->>'date')::timestamptz WHEN 'refund' THEN (p_operation->'refund'->>'date')::timestamptz ELSE (entry->>'date')::timestamptz END) < (SELECT g.cutover_at FROM public.pos_v2_branch_gate g WHERE g.branch_id=branch AND g.business_id=business) THEN RAISE EXCEPTION 'Historical transaction predates cutover; replay is blocked'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND (p.stock IS NULL OR (p.stock<0 AND NOT EXISTS(SELECT 1 FROM public.pos_v2_branch_gate g WHERE g.business_id=business AND g.branch_id=branch AND g.allow_negative_stock)))) THEN RAISE EXCEPTION 'Negative or unknown branch stock requires reviewed reconciliation'; END IF;

  IF kind='product_adjust' THEN
    updates := p_operation->'updates';
    IF jsonb_typeof(updates) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Product updates must be an object'; END IF;
    delta := (p_operation->>'quantityDelta')::integer;
    IF delta IS NULL OR (p_operation->>'quantityDelta')::numeric<>delta THEN RAISE EXCEPTION 'Invalid atomic product adjustment'; END IF;
    IF delta<>0 THEN
      PERFORM public.pos_commit_operation(jsonb_build_object('operationId',op||':stock','businessId',business,'branchId',branch,'protocolRevision',3,'createdAt',p_operation->>'createdAt','type','stock_delta','productId',p_operation->>'productId','quantityDelta',delta));
    END IF;
    PERFORM public.pos_commit_operation(jsonb_build_object('operationId',op||':metadata','businessId',business,'branchId',branch,'protocolRevision',3,'createdAt',p_operation->>'createdAt','type','product_update','productId',p_operation->>'productId','updates',updates));
    result := jsonb_build_object('operation_id',op,'confirmed',true,'already_processed',false,'product_ids','{}'::jsonb);
    INSERT INTO public.pos_v2_operations(operation_id,business_id,branch_id,request,result) VALUES(op,business,branch,p_operation,result);
    RETURN result;
  END IF;

  IF kind='refund_batch' THEN
    IF jsonb_typeof(p_operation->'refunds') IS DISTINCT FROM 'array' OR jsonb_array_length(p_operation->'refunds') NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid refund batch'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(p_operation->'refunds'))<>(SELECT count(DISTINCT r->>'id') FROM jsonb_array_elements(p_operation->'refunds') r) THEN RAISE EXCEPTION 'Duplicate refund IDs in batch'; END IF;
    FOR financial IN SELECT value FROM jsonb_array_elements(p_operation->'refunds') LOOP
      -- Nested functions share this RPC transaction and branch lock. Any
      -- later conflict rolls back every child, stock change and ledger insert.
      child_result := public.pos_commit_operation(jsonb_build_object(
        'protocolRevision',3,'createdAt',p_operation->>'createdAt',
        'operationId','refund:'||(financial->>'id'),'businessId',business,'branchId',branch,
        'type','refund','refund',financial));
      FOR map_key IN SELECT jsonb_object_keys(child_result->'product_ids') LOOP
        IF mappings ? map_key AND mappings->map_key IS DISTINCT FROM child_result->'product_ids'->map_key THEN RAISE EXCEPTION 'Conflicting canonical product mappings in refund batch'; END IF;
      END LOOP;
      mappings := mappings || child_result->'product_ids';
    END LOOP;
    result := jsonb_build_object('operation_id',op,'confirmed',true,'already_processed',false,'product_ids',mappings);
    INSERT INTO public.pos_v2_operations(operation_id,business_id,branch_id,request,result,succeeded_at) VALUES(op,business,branch,p_operation,result,now());
    RETURN result;
  END IF;

  IF kind='receive' OR kind='product_upsert' THEN
    incoming_id := incoming->>'id';
    barcode := NULLIF(btrim(incoming->>'barcode'),'');
    qty := CASE WHEN kind='receive' THEN (entry->>'quantityAdded')::integer ELSE (incoming->>'stockQuantity')::integer END;
    unit_cost := (incoming->>'purchasePrice')::numeric;
    unit_price := (incoming->>'salePrice')::numeric;
    IF incoming_id IS NULL OR barcode IS NULL OR NULLIF(btrim(incoming->>'name'),'') IS NULL OR qty IS NULL OR qty<0 OR (kind='receive' AND qty=0) OR unit_cost IS NULL OR unit_cost<0 OR unit_price IS NULL OR unit_price<0 OR unit_cost::text IN ('NaN','Infinity','-Infinity') OR unit_price::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid receipt/product payload'; END IF;
    IF kind='receive' AND (entry->>'productId' IS DISTINCT FROM incoming_id OR entry->>'barcode' IS DISTINCT FROM barcode OR (entry->>'purchasePrice')::numeric IS DISTINCT FROM unit_cost OR (entry->>'salePrice')::numeric IS DISTINCT FROM unit_price) THEN RAISE EXCEPTION 'Receipt and product payload differ'; END IF;
    IF EXISTS (SELECT 1 FROM public.products p WHERE p.business_id=business AND p.branch_id IS NULL AND (p.id=incoming_id OR p.barcode=barcode)) THEN RAISE EXCEPTION 'Shared branchless product requires reviewed branch allocation; no stock was moved'; END IF;
    IF (SELECT count(*) FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND p.barcode=barcode)>1 THEN RAISE EXCEPTION 'Duplicate barcode requires manual reconciliation'; END IF;
    SELECT * INTO product FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND p.barcode=barcode FOR UPDATE;
    product_id := COALESCE(product.id,incoming_id);
    IF EXISTS (SELECT 1 FROM public.products p WHERE p.id=incoming_id AND (p.business_id<>business OR p.branch_id IS DISTINCT FROM branch OR p.barcode IS DISTINCT FROM barcode)) THEN RAISE EXCEPTION 'Product ID scope or barcode conflict'; END IF;
    mappings := jsonb_build_object(incoming_id,product_id);
    IF kind='receive' THEN
      record_id := NULLIF(entry->>'id','');
      IF record_id IS NULL THEN RAISE EXCEPTION 'Receipt ID required'; END IF;
      SELECT * INTO existing_entry FROM public.inventory_entries WHERE id=record_id FOR UPDATE;
      IF FOUND THEN
        IF existing_entry.business_id<>business OR existing_entry.branch_id<>branch OR existing_entry.product_id<>product_id OR existing_entry.barcode IS DISTINCT FROM barcode OR existing_entry.quantity_added IS DISTINCT FROM qty OR existing_entry.purchase_price IS DISTINCT FROM unit_cost OR existing_entry.sale_price IS DISTINCT FROM unit_price OR existing_entry.product_name IS DISTINCT FROM entry->>'productName' OR existing_entry.salesman_name IS DISTINCT FROM entry->>'salesmanName' OR existing_entry.date IS DISTINCT FROM entry->>'date' THEN RAISE EXCEPTION 'Existing receipt ID has conflicting data; no stock replay allowed'; END IF;
        result := jsonb_build_object('operation_id',op,'confirmed',true,'already_processed',true,'product_ids',mappings);
        INSERT INTO public.pos_v2_operations(operation_id,business_id,branch_id,request,result,succeeded_at) VALUES (op,business,branch,p_operation,result,now());
        RETURN result;
      END IF;
    ELSIF product.id IS NOT NULL THEN
      RAISE EXCEPTION 'Product creation conflicts with existing stock; use a stock delta';
    END IF;
    INSERT INTO public.products(id,business_id,branch_id,barcode,name,cost,price,stock,is_active,updated_at)
    VALUES(product_id,business,branch,barcode,incoming->>'name',unit_cost,unit_price,qty,true,now())
    ON CONFLICT(id) DO UPDATE SET stock=COALESCE(public.products.stock,0)+qty,cost=unit_cost,price=unit_price,name=EXCLUDED.name,is_active=true,updated_at=now()
    WHERE public.products.business_id=business AND public.products.branch_id=branch;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product identity conflict'; END IF;
    IF kind='receive' THEN
      INSERT INTO public.inventory_entries(id,business_id,branch_id,product_id,product_name,barcode,quantity_added,purchase_price,sale_price,salesman_name,date,synced_at)
      VALUES(record_id,business,branch,product_id,entry->>'productName',barcode,qty,unit_cost,unit_price,COALESCE(entry->>'salesmanName',''),entry->>'date',now());
    END IF;

  ELSIF kind IN ('sale','refund') THEN
    financial := CASE WHEN kind='sale' THEN p_operation->'sale' ELSE p_operation->'refund' END;
    record_id := NULLIF(financial->>'id','');
    exchange_rate := (financial->>'exchangeRate')::numeric;
    IF record_id IS NULL OR financial->>'date' IS NULL OR financial->>'currency' IS NULL OR financial->>'currency' NOT IN ('USD','LBP') OR exchange_rate IS NULL OR exchange_rate<=0 OR exchange_rate::text IN ('NaN','Infinity','-Infinity') OR jsonb_typeof(financial->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(financial->'items')=0 THEN RAISE EXCEPTION 'Invalid financial payload'; END IF;
    PERFORM (financial->>'date')::timestamptz;
    IF (SELECT count(*) FROM jsonb_array_elements(financial->'items')) <> (SELECT count(DISTINCT i->>'productId') FROM jsonb_array_elements(financial->'items') i) THEN RAISE EXCEPTION 'Duplicate financial product line'; END IF;
    IF kind='sale' THEN
      IF EXISTS (SELECT 1 FROM public.pos_v2_sales WHERE id=record_id) THEN RAISE EXCEPTION 'Sale ID already exists under another operation'; END IF;
    ELSE
      sale_id := financial->>'saleId';
      SELECT record INTO original FROM public.pos_v2_sales WHERE id=sale_id AND business_id=business AND branch_id=branch FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Original sale must be synced or legacy history reconciled before refund'; END IF;
      IF EXISTS (SELECT 1 FROM public.pos_v2_refunds WHERE id=record_id) THEN RAISE EXCEPTION 'Refund ID already exists under another operation'; END IF;
    END IF;
    FOR line IN SELECT value FROM jsonb_array_elements(financial->'items') ORDER BY value->>'productId' LOOP
      IF line->>'currency' IS NULL OR line->>'currency' NOT IN ('USD','LBP') OR NULLIF(btrim(line->>'productName'),'') IS NULL THEN RAISE EXCEPTION 'Invalid financial line'; END IF;
      incoming_id := line->>'productId'; barcode := line->>'barcode'; qty := (line->>'quantity')::integer;
      IF qty IS NULL OR qty<=0 OR (line->>'quantity')::numeric <> qty THEN RAISE EXCEPTION 'Quantity must be a positive integer'; END IF;
      SELECT * INTO product FROM public.products p WHERE p.id=incoming_id AND p.business_id=business AND p.branch_id=branch FOR UPDATE;
      IF NOT FOUND THEN
        IF (SELECT count(*) FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND p.barcode=barcode)<>1 THEN RAISE EXCEPTION 'Product identity cannot be resolved safely'; END IF;
        SELECT * INTO product FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND p.barcode=barcode FOR UPDATE;
      END IF;
      IF kind='sale' AND (product.barcode IS DISTINCT FROM barcode OR product.is_active IS DISTINCT FROM true) THEN RAISE EXCEPTION 'Product is inactive or barcode conflicts'; END IF;
      product_id := product.id;
      IF product_id=ANY(resolved_ids) THEN RAISE EXCEPTION 'Multiple lines resolve to the same canonical product'; END IF;
      resolved_ids := array_append(resolved_ids,product_id);
      mappings := mappings || jsonb_build_object(incoming_id,product_id);
      unit_price := (line->>'salePrice')::numeric; unit_cost := (line->>'purchasePrice')::numeric;
      IF unit_price IS NULL OR unit_price<0 OR unit_cost IS NULL OR unit_cost<0 OR unit_price::text IN ('NaN','Infinity','-Infinity') OR unit_cost::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid financial price'; END IF;
      IF kind='sale' THEN
        IF product.stock IS NULL OR (product.stock<qty AND NOT EXISTS(SELECT 1 FROM public.pos_v2_branch_gate g WHERE g.business_id=business AND g.branch_id=branch AND g.allow_negative_stock)) THEN RAISE EXCEPTION 'Insufficient cloud stock; resolve offline conflict'; END IF;
        IF product.cost IS DISTINCT FROM unit_cost THEN RAISE EXCEPTION 'Sale cost changed; reconciliation required'; END IF;
        IF product.price IS DISTINCT FROM unit_price THEN RAISE EXCEPTION 'Sale price changed; administrator reconciliation required'; END IF;
        delta := -qty;
      ELSE
        SELECT value INTO original_line FROM jsonb_array_elements(original->'items') WHERE value->>'productId'=product_id;
        IF original_line IS NULL THEN RAISE EXCEPTION 'Product was not sold on this receipt'; END IF;
        IF barcode IS DISTINCT FROM original_line->>'barcode' OR line->>'productName' IS DISTINCT FROM original_line->>'productName' THEN RAISE EXCEPTION 'Refund identity must match the immutable original sale'; END IF;
        sold := (original_line->>'quantity')::integer;
        SELECT COALESCE(sum((i->>'quantity')::integer),0)::integer INTO returned FROM public.pos_v2_refunds r CROSS JOIN LATERAL jsonb_array_elements(r.record->'items') i WHERE r.sale_id=sale_id AND i->>'productId'=product_id;
        IF qty>sold-returned THEN RAISE EXCEPTION 'Refund exceeds sold quantity'; END IF;
        IF unit_price IS DISTINCT FROM (original_line->>'salePrice')::numeric OR unit_cost IS DISTINCT FROM (original_line->>'purchasePrice')::numeric THEN RAISE EXCEPTION 'Refund prices must match original sale'; END IF;
        delta := qty;
      END IF;
      UPDATE public.products SET stock=COALESCE(stock,0)+delta,updated_at=now() WHERE id=product_id AND business_id=business AND branch_id=branch;
      lines := lines || jsonb_build_array(line || jsonb_build_object('productId',product_id));
      subtotal := subtotal + unit_price*qty;
    END LOOP;
    subtotal := round(subtotal,2);
    financial := financial || jsonb_build_object('items',lines);
    IF kind='sale' THEN financial := financial || jsonb_build_object('legacy',false,'refunded',false); END IF;
    IF kind='sale' THEN
      IF (financial->>'subtotal')::numeric IS DISTINCT FROM subtotal OR (financial->>'total')::numeric IS DISTINCT FROM (CASE WHEN financial->>'currency'='USD' THEN subtotal ELSE round(subtotal*exchange_rate) END) THEN RAISE EXCEPTION 'Sale total mismatch'; END IF;
      INSERT INTO public.sales(id,business_id,branch_id,subtotal,total,currency,exchange_rate,cashier_name,date,refunded,synced_at)
      VALUES(record_id,business,branch,subtotal,(financial->>'total')::numeric,financial->>'currency',exchange_rate,financial->>'cashierName',financial->>'date',false,now());
      INSERT INTO public.sale_items(id,sale_id,business_id,branch_id,product_id,product_name,barcode,quantity,sale_price,purchase_price,currency)
      SELECT 'v2:'||length(record_id)::text||':'||record_id||':'||(i->>'productId'),record_id,business,branch,i->>'productId',i->>'productName',i->>'barcode',(i->>'quantity')::integer,(i->>'salePrice')::numeric,(i->>'purchasePrice')::numeric,i->>'currency' FROM jsonb_array_elements(lines) i;
      INSERT INTO public.pos_v2_sales(id,business_id,branch_id,record) VALUES(record_id,business,branch,financial);
    ELSE
      IF (financial->>'totalRefunded')::numeric IS DISTINCT FROM (CASE WHEN financial->>'currency'='USD' THEN subtotal ELSE round(subtotal*exchange_rate) END) THEN RAISE EXCEPTION 'Refund total mismatch'; END IF;
      INSERT INTO public.refunds(id,business_id,branch_id,sale_id,total_refunded,currency,date,cashier_name,synced_at)
      VALUES(record_id,business,branch,sale_id,(financial->>'totalRefunded')::numeric,financial->>'currency',financial->>'date',financial->>'cashierName',now());
      INSERT INTO public.refund_items(id,refund_id,business_id,branch_id,product_id,product_name,barcode,quantity,sale_price,purchase_price,currency)
      SELECT 'v2:'||length(record_id)::text||':'||record_id||':'||(i->>'productId'),record_id,business,branch,i->>'productId',i->>'productName',i->>'barcode',(i->>'quantity')::integer,(i->>'salePrice')::numeric,(i->>'purchasePrice')::numeric,i->>'currency' FROM jsonb_array_elements(lines) i;
      INSERT INTO public.pos_v2_refunds(id,sale_id,business_id,branch_id,record) VALUES(record_id,sale_id,business,branch,financial);
    END IF;

  ELSIF kind='inventory_entry_delete' THEN
    -- Legacy deletion requests are recorded as history-retention events. No
    -- receipt row or stock is deleted, regenerated, or replayed.
    NULL;
  ELSIF kind='inventory_entry_update' THEN
    updates := p_operation->'updates';
    IF jsonb_typeof(updates) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Updates must be an object'; END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(updates) k WHERE k NOT IN ('date','salesmanName')) THEN RAISE EXCEPTION 'Receipt amounts and identity are immutable'; END IF;
    IF updates ? 'date' THEN PERFORM (updates->>'date')::timestamptz; END IF;
    UPDATE public.inventory_entries SET salesman_name=COALESCE(updates->>'salesmanName',salesman_name),date=COALESCE(updates->>'date',date) WHERE id=p_operation->>'entryId' AND business_id=business AND branch_id=branch;
    IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  ELSE
    product_id := p_operation->>'productId';
    SELECT * INTO product FROM public.products p WHERE p.id=product_id AND p.business_id=business AND p.branch_id=branch FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product unavailable in this exact branch'; END IF;
    IF kind='stock_delta' THEN
      delta := (p_operation->>'quantityDelta')::integer;
      IF delta IS NULL OR delta=0 OR (p_operation->>'quantityDelta')::numeric<>delta OR (COALESCE(product.stock,0)+delta<0 AND NOT EXISTS(SELECT 1 FROM public.pos_v2_branch_gate g WHERE g.business_id=business AND g.branch_id=branch AND g.allow_negative_stock)) THEN RAISE EXCEPTION 'Invalid stock adjustment or insufficient stock'; END IF;
      UPDATE public.products SET stock=COALESCE(stock,0)+delta,updated_at=now() WHERE id=product_id;
    ELSIF kind='product_delete' THEN
      IF EXISTS(SELECT 1 FROM public.sale_items i WHERE i.business_id=business AND i.branch_id=branch AND i.product_id=product_id AND NOT EXISTS(SELECT 1 FROM public.pos_v2_sales s WHERE s.id=i.sale_id)) OR EXISTS(SELECT 1 FROM public.sales s WHERE s.business_id=business AND s.branch_id=branch AND NOT EXISTS(SELECT 1 FROM public.sale_items i WHERE i.sale_id=s.id)) THEN RAISE EXCEPTION 'Unverified legacy refund obligations require reviewed reconciliation'; END IF;
      IF EXISTS (SELECT 1 FROM public.pos_v2_sales s CROSS JOIN LATERAL jsonb_array_elements(s.record->'items') i WHERE s.business_id=business AND s.branch_id=branch AND i->>'productId'=product_id AND (i->>'quantity')::integer>(SELECT COALESCE(sum((ri->>'quantity')::integer),0) FROM public.pos_v2_refunds r CROSS JOIN LATERAL jsonb_array_elements(r.record->'items') ri WHERE r.sale_id=s.id AND ri->>'productId'=product_id)) THEN RAISE EXCEPTION 'Product still has refundable sales'; END IF;
      UPDATE public.products SET is_active=false,updated_at=now() WHERE id=product_id;
    ELSE
      updates := p_operation->'updates';
      IF jsonb_typeof(updates) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Updates must be an object'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_each(updates) u WHERE u.value='null'::jsonb) THEN RAISE EXCEPTION 'Product updates cannot contain null values'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_object_keys(updates) k WHERE k NOT IN ('name','barcode','purchasePrice','salePrice')) THEN RAISE EXCEPTION 'Unsupported product update'; END IF;
      IF (updates ? 'purchasePrice' AND ((updates->>'purchasePrice')::numeric<0 OR (updates->>'purchasePrice')::numeric::text IN ('NaN','Infinity','-Infinity'))) OR (updates ? 'salePrice' AND ((updates->>'salePrice')::numeric<0 OR (updates->>'salePrice')::numeric::text IN ('NaN','Infinity','-Infinity'))) THEN RAISE EXCEPTION 'Invalid product price'; END IF;
      IF (updates ? 'name' AND NULLIF(btrim(updates->>'name'),'') IS NULL) OR (updates ? 'barcode' AND NULLIF(btrim(updates->>'barcode'),'') IS NULL) THEN RAISE EXCEPTION 'Product name and barcode cannot be empty'; END IF;
      IF updates ? 'barcode' AND EXISTS (SELECT 1 FROM public.products p WHERE p.business_id=business AND p.branch_id=branch AND p.id<>product_id AND p.barcode=updates->>'barcode') THEN RAISE EXCEPTION 'Barcode already exists'; END IF;
      UPDATE public.products SET name=COALESCE(updates->>'name',name),barcode=COALESCE(updates->>'barcode',barcode),cost=COALESCE((updates->>'purchasePrice')::numeric,cost),price=COALESCE((updates->>'salePrice')::numeric,price),updated_at=now() WHERE id=product_id;
    END IF;
  END IF;
  result := jsonb_build_object('operation_id',op,'confirmed',true,'already_processed',false,'product_ids',mappings);
  INSERT INTO public.pos_v2_operations(operation_id,business_id,branch_id,request,result,succeeded_at) VALUES(op,business,branch,p_operation,result,now());
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.pos_branch_snapshot(p_business_id uuid,p_branch_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF public.pos_authenticated_owner_id() IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches br JOIN public.businesses b ON b.id=br.business_id WHERE br.id=p_branch_id AND br.business_id=p_business_id AND b.owner_id=public.pos_authenticated_owner_id()) THEN RAISE EXCEPTION 'Unauthorized branch snapshot'; END IF;
  IF EXISTS(SELECT 1 FROM public.products WHERE business_id=p_business_id AND branch_id IS NULL AND is_active) THEN RAISE EXCEPTION 'Shared products require reviewed branch allocation'; END IF;
  RETURN jsonb_build_object(
    'allowNegativeStock',COALESCE((SELECT allow_negative_stock FROM public.pos_v2_branch_gate WHERE business_id=p_business_id AND branch_id=p_branch_id),false),
    'products',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'barcode',barcode,'name',name,'purchasePrice',cost,'salePrice',price,'stockQuantity',stock,'isActive',is_active IS TRUE) ORDER BY id) FROM public.products WHERE business_id=p_business_id AND branch_id=p_branch_id),'[]'::jsonb),
    'entries',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'productId',product_id,'productName',product_name,'barcode',barcode,'quantityAdded',quantity_added,'purchasePrice',purchase_price,'salePrice',sale_price,'salesmanName',salesman_name,'date',date) ORDER BY id) FROM public.inventory_entries WHERE business_id=p_business_id AND branch_id=p_branch_id),'[]'::jsonb),
    'sales',COALESCE((SELECT jsonb_agg(record ORDER BY id) FROM public.pos_v2_sales WHERE business_id=p_business_id AND branch_id=p_branch_id),'[]'::jsonb),
    'refunds',COALESCE((SELECT jsonb_agg(record ORDER BY id) FROM public.pos_v2_refunds WHERE business_id=p_business_id AND branch_id=p_branch_id),'[]'::jsonb)
  );
END;
$$;
-- Read-only, single-statement financial snapshot avoids REST row limits and
-- cross-page drift. Historical rows are returned separately, never fabricated.
CREATE OR REPLACE FUNCTION public.pos_dashboard_snapshot(p_business_id uuid,p_branch_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
 IF public.pos_authenticated_owner_id() IS NULL OR NOT EXISTS(SELECT 1 FROM public.businesses WHERE id=p_business_id AND owner_id=public.pos_authenticated_owner_id()) OR p_branch_ids IS NULL OR cardinality(p_branch_ids)=0 OR EXISTS(SELECT 1 FROM unnest(p_branch_ids) x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.branches b WHERE b.id=x AND b.business_id=p_business_id)) THEN RAISE EXCEPTION 'Unauthorized Dashboard scope'; END IF;
 RETURN jsonb_build_object(
 'products',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM public.products p WHERE business_id=p_business_id AND branch_id=ANY(p_branch_ids) AND is_active IS TRUE),'[]'::jsonb),
 'sales',COALESCE((SELECT jsonb_agg(jsonb_build_object('business_id',business_id,'branch_id',branch_id,'record',record) ORDER BY id) FROM public.pos_v2_sales WHERE business_id=p_business_id AND branch_id=ANY(p_branch_ids)),'[]'::jsonb),
 'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('business_id',business_id,'branch_id',branch_id,'record',record) ORDER BY id) FROM public.pos_v2_refunds WHERE business_id=p_business_id AND branch_id=ANY(p_branch_ids)),'[]'::jsonb),
 'historical',jsonb_build_object(
 'sales',COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM public.sales s WHERE s.business_id=p_business_id AND s.branch_id=ANY(p_branch_ids) AND NOT EXISTS(SELECT 1 FROM public.pos_v2_sales v WHERE v.id=s.id)),'[]'::jsonb),
 'sale_items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.sale_items i WHERE i.business_id=p_business_id AND i.branch_id=ANY(p_branch_ids) AND NOT EXISTS(SELECT 1 FROM public.pos_v2_sales v WHERE v.id=i.sale_id)),'[]'::jsonb),
 'refunds',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM public.refunds r WHERE r.business_id=p_business_id AND r.branch_id=ANY(p_branch_ids) AND NOT EXISTS(SELECT 1 FROM public.pos_v2_refunds v WHERE v.id=r.id)),'[]'::jsonb),
 'refund_items',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM public.refund_items i WHERE i.business_id=p_business_id AND i.branch_id=ANY(p_branch_ids) AND NOT EXISTS(SELECT 1 FROM public.pos_v2_refunds v WHERE v.id=i.refund_id)),'[]'::jsonb)
 ));
END $$;
ALTER FUNCTION public.pos_dashboard_snapshot(uuid,uuid[]) OWNER TO pos_v2_executor;
REVOKE ALL ON FUNCTION public.pos_dashboard_snapshot(uuid,uuid[]) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.pos_dashboard_snapshot(uuid,uuid[]) TO authenticated;
ALTER FUNCTION public.pos_commit_operation(jsonb) OWNER TO pos_v2_executor;
ALTER FUNCTION public.pos_branch_snapshot(uuid,uuid) OWNER TO pos_v2_executor;
REVOKE ALL ON FUNCTION public.pos_commit_operation(jsonb), public.pos_branch_snapshot(uuid,uuid), public.pos_sync_protocol() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.pos_commit_operation(jsonb), public.pos_branch_snapshot(uuid,uuid), public.pos_sync_protocol() TO authenticated;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM pos_v2_executor;
DO $$ BEGIN EXECUTE format('GRANT pos_v2_executor TO %I WITH SET FALSE, INHERIT FALSE',current_user); END $$;
-- Disable obsolete mutation entrypoints without dropping functions or ledgers.
DO $$
BEGIN
  IF to_regprocedure('public.pos_receive_inventory(jsonb,jsonb)') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.pos_receive_inventory(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role; END IF;
  IF to_regprocedure('public.pos_apply_inventory_stock_delta(text,uuid,uuid,text,integer)') IS NOT NULL THEN REVOKE EXECUTE ON FUNCTION public.pos_apply_inventory_stock_delta(text,uuid,uuid,text,integer) FROM PUBLIC,anon,authenticated,service_role; END IF;
END;
$$;
COMMIT;
