CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE INDEX IF NOT EXISTS idx_sales_refunded ON sales(refunded);
CREATE INDEX IF NOT EXISTS idx_sale_items_saleId ON sale_items(saleId);
CREATE INDEX IF NOT EXISTS idx_sale_items_barcode ON sale_items(barcode);
CREATE INDEX IF NOT EXISTS idx_refunds_date ON refunds(date);
CREATE INDEX IF NOT EXISTS idx_refund_items_refundId ON refund_items(refundId);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);