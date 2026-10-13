-- SELECT-only aggregate diagnostics. No payloads, customer details or mutations.
-- Run only after confirming the current public schema matches these columns.
SELECT jsonb_build_object(
 'observed_at',now(),'negative_products',(SELECT count(*) FROM public.products WHERE stock<0),
 'unknown_stock',(SELECT count(*) FROM public.products WHERE stock IS NULL),
 'active_branchless_products',(SELECT count(*) FROM public.products WHERE branch_id IS NULL AND is_active IS TRUE),
 'duplicate_branch_barcodes',(SELECT count(*) FROM (SELECT business_id,branch_id,barcode FROM public.products WHERE barcode IS NOT NULL AND btrim(barcode)<>'' GROUP BY business_id,branch_id,barcode HAVING count(*)>1) d),
 'sales_without_items',(SELECT count(*) FROM public.sales s WHERE NOT EXISTS(SELECT 1 FROM public.sale_items i WHERE i.sale_id=s.id)),
 'refunds_without_items',(SELECT count(*) FROM public.refunds r WHERE NOT EXISTS(SELECT 1 FROM public.refund_items i WHERE i.refund_id=r.id)),
 'receipts_missing_products',(SELECT count(*) FROM public.inventory_entries i WHERE NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=i.product_id)),
 'sale_items_missing_products',(SELECT count(*) FROM public.sale_items i WHERE NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=i.product_id)),
 'refund_items_missing_products',(SELECT count(*) FROM public.refund_items i WHERE NOT EXISTS(SELECT 1 FROM public.products p WHERE p.id=i.product_id)),
 'sale_item_scope_mismatches',(SELECT count(*) FROM public.sale_items i JOIN public.sales s ON s.id=i.sale_id WHERE i.business_id IS DISTINCT FROM s.business_id OR i.branch_id IS DISTINCT FROM s.branch_id),
 'refund_item_scope_mismatches',(SELECT count(*) FROM public.refund_items i JOIN public.refunds r ON r.id=i.refund_id WHERE i.business_id IS DISTINCT FROM r.business_id OR i.branch_id IS DISTINCT FROM r.branch_id),
 'sale_header_item_mismatches',(SELECT count(*) FROM public.sales s WHERE s.subtotal IS DISTINCT FROM (SELECT round(sum(i.quantity*i.sale_price),2) FROM public.sale_items i WHERE i.sale_id=s.id)),
 'refund_quantity_comparison_flags',(SELECT count(*) FROM (SELECT r.sale_id,i.product_id,sum(i.quantity) AS returned FROM public.refunds r JOIN public.refund_items i ON i.refund_id=r.id GROUP BY r.sale_id,i.product_id) rf WHERE rf.returned>COALESCE((SELECT sum(s.quantity) FROM public.sale_items s WHERE s.sale_id=rf.sale_id AND s.product_id=rf.product_id),0)),
 'legacy_ledger_present',to_regclass('public.inventory_sync_operations') IS NOT NULL,
 'v2_ledger_present',to_regclass('public.pos_v2_operations') IS NOT NULL
) AS reconciliation_summary;
