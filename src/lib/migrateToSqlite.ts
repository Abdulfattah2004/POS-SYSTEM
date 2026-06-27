import { getDb } from "./sqlStore";

function getLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function migrateLocalStorageToSqlite() {
  const db = await getDb();

  const alreadyMigrated = localStorage.getItem("pos_migrated_to_sqlite");

  if (alreadyMigrated === "true") {
    return;
  }

  const products = getLocal<any[]>("pos_products", []);
  const sales = getLocal<any[]>("pos_sales", []);
  const users = getLocal<any[]>("pos_users", []);
  const refunds = getLocal<any[]>("pos_refunds", []);
  const inventoryEntries = getLocal<any[]>("pos_inventory_entries", []);
  const exchangeRate = getLocal<number>("pos_exchange_rate", 89500);

  for (const user of users) {
    await db.execute(
      `INSERT OR IGNORE INTO users (id, username, password, role, name)
       VALUES (?, ?, ?, ?, ?)`,
      [user.id, user.username, user.password, user.role, user.name]
    );
  }

  for (const product of products) {
    await db.execute(
      `INSERT OR REPLACE INTO products 
       (id, barcode, name, stockQuantity, purchasePrice, salePrice, synced)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        product.id,
        product.barcode,
        product.name,
        Number(product.stockQuantity ?? 0),
        Number(product.purchasePrice ?? 0),
        Number(product.salePrice ?? 0),
      ]
    );
  }

  for (const sale of sales) {
    await db.execute(
      `INSERT OR IGNORE INTO sales 
       (id, subtotal, total, currency, exchangeRate, cashierName, date, refunded, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        sale.id,
        Number(sale.subtotal ?? 0),
        Number(sale.total ?? 0),
        sale.currency,
        Number(sale.exchangeRate ?? 89500),
        sale.cashierName ?? "",
        sale.date,
        sale.refunded ? 1 : 0,
      ]
    );

    for (const item of sale.items || []) {
      await db.execute(
        `INSERT OR IGNORE INTO sale_items
         (id, saleId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          generateId(),
          sale.id,
          item.productId,
          item.productName,
          item.barcode,
          Number(item.quantity ?? 0),
          Number(item.salePrice ?? 0),
          Number(item.purchasePrice ?? 0),
          item.currency,
        ]
      );
    }
  }

  for (const refund of refunds) {
    await db.execute(
      `INSERT OR IGNORE INTO refunds 
       (id, saleId, totalRefunded, currency, date, cashierName, synced)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [
        refund.id,
        refund.saleId,
        Number(refund.totalRefunded ?? 0),
        refund.currency,
        refund.date,
        refund.cashierName ?? "",
      ]
    );

    for (const item of refund.items || []) {
      await db.execute(
        `INSERT OR IGNORE INTO refund_items
         (id, refundId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency, synced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          generateId(),
          refund.id,
          item.productId,
          item.productName ?? "",
          item.barcode ?? "",
          Number(item.quantity ?? 0),
          Number(item.salePrice ?? 0),
          Number(item.purchasePrice ?? 0),
          item.currency ?? refund.currency,
        ]
      );
    }
  }

  for (const entry of inventoryEntries) {
    await db.execute(
      `INSERT OR IGNORE INTO inventory_entries
       (id, productId, productName, barcode, quantityAdded, purchasePrice, salePrice, salesmanName, date, synced)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        entry.id,
        entry.productId ?? "",
        entry.productName,
        entry.barcode,
        Number(entry.quantityAdded ?? 0),
        Number(entry.purchasePrice ?? 0),
        Number(entry.salePrice ?? 0),
        entry.salesmanName ?? "",
        entry.date,
      ]
    );
  }

  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ["exchange_rate", String(exchangeRate)]
  );

  localStorage.setItem("pos_migrated_to_sqlite", "true");

  console.log("Migration to SQLite completed successfully");
}