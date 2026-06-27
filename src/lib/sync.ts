import { supabase } from "./supabase";
import { getSetting } from "./localSettings";

async function getCloudConfig(db: any) {
  const businessId = await getSetting(db, "business_id");
  const branchId = await getSetting(db, "branch_id");

  if (!businessId || !branchId) {
    throw new Error("Missing business_id or branch_id in local settings");
  }

  return { businessId, branchId };
}

async function markSynced(db: any, table: string, rows: any[]) {
  for (const row of rows) {
    await db.execute(`UPDATE ${table} SET synced = 1 WHERE id = ?`, [row.id]);
  }
}

export async function syncProducts(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const products = await db.select("SELECT * FROM products WHERE synced = 0");

  if (products.length === 0) return true;

  const mapped = products.map((p: any) => ({
    id: p.id,
    business_id: businessId,
    branch_id: branchId,
    barcode: p.barcode,
    name: p.name,
    stock: p.stockQuantity,
    cost: p.purchasePrice,
    price: p.salePrice,
    minimum_stock: 0,
    is_active: true,
  }));

  const { error } = await supabase.from("products").upsert(mapped);

  if (error) {
    console.error("Products sync failed:", error);
    return false;
  }

  await markSynced(db, "products", products);
  console.log("Products synced:", products.length);
  return true;
}

export async function syncSales(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const sales = await db.select("SELECT * FROM sales WHERE synced = 0");

  if (sales.length === 0) return true;

  const mapped = sales.map((s: any) => ({
    id: s.id,
    business_id: businessId,
    branch_id: branchId,
    subtotal: s.subtotal,
    total: s.total,
    currency: s.currency,
    exchange_rate: s.exchangeRate,
    cashier_name: s.cashierName,
    date: s.date,
    refunded: Boolean(s.refunded),
  }));

  const { error } = await supabase.from("sales").upsert(mapped);

  if (error) {
    console.error("Sales sync failed:", error);
    return false;
  }

  await markSynced(db, "sales", sales);
  console.log("Sales synced:", sales.length);
  return true;
}

export async function syncSaleItems(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const items = await db.select("SELECT * FROM sale_items WHERE synced = 0");

  if (items.length === 0) return true;

  const mapped = items.map((i: any) => ({
    id: i.id,
    sale_id: i.saleId,
    business_id: businessId,
    branch_id: branchId,
    product_id: i.productId,
    product_name: i.productName,
    barcode: i.barcode,
    quantity: i.quantity,
    sale_price: i.salePrice,
    purchase_price: i.purchasePrice,
    currency: i.currency,
  }));

  const { error } = await supabase.from("sale_items").upsert(mapped);

  if (error) {
    console.error("Sale items sync failed:", error);
    return false;
  }

  await markSynced(db, "sale_items", items);
  console.log("Sale items synced:", items.length);
  return true;
}

export async function syncRefunds(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const refunds = await db.select("SELECT * FROM refunds WHERE synced = 0");

  if (refunds.length === 0) return true;

  const mapped = refunds.map((r: any) => ({
    id: r.id,
    business_id: businessId,
    branch_id: branchId,
    sale_id: r.saleId,
    total_refunded: r.totalRefunded,
    currency: r.currency,
    date: r.date,
    cashier_name: r.cashierName,
  }));

  const { error } = await supabase.from("refunds").upsert(mapped);

  if (error) {
    console.error("Refunds sync failed:", error);
    return false;
  }

  await markSynced(db, "refunds", refunds);
  console.log("Refunds synced:", refunds.length);
  return true;
}

export async function syncRefundItems(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const items = await db.select("SELECT * FROM refund_items WHERE synced = 0");

  if (items.length === 0) return true;

  const mapped = items.map((i: any) => ({
    id: i.id,
    refund_id: i.refundId,
    business_id: businessId,
    branch_id: branchId,
    product_id: i.productId,
    product_name: i.productName,
    barcode: i.barcode,
    quantity: i.quantity,
    sale_price: i.salePrice,
    purchase_price: i.purchasePrice,
    currency: i.currency,
  }));

  const { error } = await supabase.from("refund_items").upsert(mapped);

  if (error) {
    console.error("Refund items sync failed:", error);
    return false;
  }

  await markSynced(db, "refund_items", items);
  console.log("Refund items synced:", items.length);
  return true;
}

export async function syncInventoryEntries(db: any) {
  const { businessId, branchId } = await getCloudConfig(db);
  const entries = await db.select(
    "SELECT * FROM inventory_entries WHERE synced = 0"
  );

  if (entries.length === 0) return true;

  const mapped = entries.map((e: any) => ({
    id: e.id,
    business_id: businessId,
    branch_id: branchId,
    product_id: e.productId,
    product_name: e.productName,
    barcode: e.barcode,
    quantity_added: e.quantityAdded,
    purchase_price: e.purchasePrice,
    sale_price: e.salePrice,
    salesman_name: e.salesmanName,
    date: e.date,
  }));

  const { error } = await supabase.from("inventory_entries").upsert(mapped);

  if (error) {
    console.error("Inventory entries sync failed:", error);
    return false;
  }

  await markSynced(db, "inventory_entries", entries);
  console.log("Inventory entries synced:", entries.length);
  return true;
}

export async function syncAll(db: any) {
  await syncProducts(db);
  await syncSales(db);
  await syncSaleItems(db);
  await syncRefunds(db);
  await syncRefundItems(db);
  await syncInventoryEntries(db);

  console.log("Smart cloud sync completed");
}