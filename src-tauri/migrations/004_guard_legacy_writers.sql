-- Additive upgrade: retained relational business tables are historical evidence.
-- Once durable state exists, old clients must not fork it by writing these tables.
CREATE TRIGGER IF NOT EXISTS swift_till_v4_products_insert
BEFORE INSERT ON products
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_products_update
BEFORE UPDATE ON products
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_products_delete
BEFORE DELETE ON products
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_inventory_entries_insert
BEFORE INSERT ON inventory_entries
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_inventory_entries_update
BEFORE UPDATE ON inventory_entries
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_inventory_entries_delete
BEFORE DELETE ON inventory_entries
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sales_insert
BEFORE INSERT ON sales
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sales_update
BEFORE UPDATE ON sales
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sales_delete
BEFORE DELETE ON sales
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sale_items_insert
BEFORE INSERT ON sale_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sale_items_update
BEFORE UPDATE ON sale_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_sale_items_delete
BEFORE DELETE ON sale_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refunds_insert
BEFORE INSERT ON refunds
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refunds_update
BEFORE UPDATE ON refunds
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refunds_delete
BEFORE DELETE ON refunds
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refund_items_insert
BEFORE INSERT ON refund_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refund_items_update
BEFORE UPDATE ON refund_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

CREATE TRIGGER IF NOT EXISTS swift_till_v4_refund_items_delete
BEFORE DELETE ON refund_items
WHEN EXISTS (SELECT 1 FROM pos_state WHERE id=1)
BEGIN
  SELECT RAISE(ABORT, 'Legacy clients cannot write historical tables after durable POS upgrade. Use the upgraded Swift Till application.');
END;

INSERT INTO pos_upgrade_events(version, description) VALUES
(4, 'Protect retained historical tables from incompatible legacy-client writes')
ON CONFLICT(version) DO NOTHING;
