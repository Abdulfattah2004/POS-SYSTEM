-- Protected full business history; never publish result in source/installer ZIPs.
-- Refresh together with pos_sync_v2_preflight_readonly.sql. No mutation.
BEGIN READ ONLY;
SET LOCAL statement_timeout='60s';
SELECT jsonb_build_object(
 'observedAt',now(),'projectRef','ncbyahoyhrbmunqkisuq',
 'businessId','1593a757-910c-4e45-8dd2-26436bae0347',
 'reviewBranchId','64bb012f-4070-4ef8-87b7-a3f836e522a9',
 'products',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.products t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347'),
 'inventory_entries',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.inventory_entries t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347'),
 'sales',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.sales t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347'),
 'sale_items',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.sale_items t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347' OR sale_id IN (SELECT id FROM public.sales WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347')),
 'refunds',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.refunds t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347'),
 'refund_items',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM public.refund_items t WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347' OR refund_id IN (SELECT id FROM public.refunds WHERE business_id='1593a757-910c-4e45-8dd2-26436bae0347'))
) AS protected_reconciliation_export;
COMMIT;
-- Capture every PRESENT legacy/v2 ledger separately after inspecting its schema.
-- Preserve null/foreign branch records for ownership review, never auto-merge them.
