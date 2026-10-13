-- REVIEW ONLY: stop-writes rollback. Never run without explicit approval.
-- Keep every product, quantity, sale, refund and successful ledger record.
-- Stop POS clients first. This does not restore unsafe legacy write grants.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_setting('pos.rollback_approved',true) IS DISTINCT FROM 'yes' THEN RAISE EXCEPTION 'Explicit rollback approval required'; END IF;
 EXECUTE format('GRANT pos_v2_executor TO %I WITH SET TRUE, INHERIT FALSE',current_user);
END $$;
LOCK TABLE public.pos_v2_branch_gate IN ACCESS EXCLUSIVE MODE;
UPDATE public.pos_v2_branch_gate SET writes_enabled=false WHERE writes_enabled;
SET LOCAL ROLE pos_v2_executor;
REVOKE EXECUTE ON FUNCTION public.pos_commit_operation(jsonb) FROM PUBLIC,anon,authenticated,service_role;
RESET ROLE;
DO $$ BEGIN EXECUTE format('GRANT pos_v2_executor TO %I WITH SET FALSE, INHERIT FALSE',current_user); END $$;
COMMIT;
-- Read-only Dashboard/branch snapshots stay available.
-- Fix forward against retained records. Do not drop tables or replay queues.
