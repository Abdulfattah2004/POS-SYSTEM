import Database from '@tauri-apps/plugin-sql';
import {
  Product,
  Sale,
  SaleItem,
  InventoryEntry,
  Refund,
  RefundItem,
  User,
} from '@/types/pos';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load('sqlite:pos_v2.db');
  }

  return dbInstance;
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function getProductsSql(): Promise<Product[]> {
  const db = await getDb();
  return await db.select<Product[]>('SELECT * FROM products ORDER BY name ASC');
}

export async function getProductByBarcodeSql(barcode: string): Promise<Product | undefined> {
  const db = await getDb();

  const products = await db.select<Product[]>(
    'SELECT * FROM products WHERE barcode = ? LIMIT 1',
    [barcode]
  );

  return products[0];
}

export async function updateProductStockSql(
  productId: string,
  quantityChange: number
): Promise<void> {
  const db = await getDb();

  await db.execute(
    'UPDATE products SET stockQuantity = stockQuantity + ? WHERE id = ?',
    [quantityChange, productId]
  );
}

export async function getSalesSql(): Promise<Sale[]> {
  const db = await getDb();

  const sales = await db.select<any[]>(
    'SELECT * FROM sales ORDER BY date DESC'
  );

  const saleItems = await db.select<any[]>(
    `SELECT saleId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency
     FROM sale_items`
  );

  const itemsBySale = new Map<string, SaleItem[]>();

  for (const item of saleItems) {
    const saleId = item.saleId;

    if (!itemsBySale.has(saleId)) {
      itemsBySale.set(saleId, []);
    }

    itemsBySale.get(saleId)!.push({
      productId: item.productId,
      productName: item.productName,
      barcode: item.barcode,
      quantity: Number(item.quantity),
      salePrice: Number(item.salePrice),
      purchasePrice: Number(item.purchasePrice),
      currency: item.currency,
    });
  }

  return sales.map(sale => ({
    id: sale.id,
    subtotal: Number(sale.subtotal),
    total: Number(sale.total),
    currency: sale.currency,
    exchangeRate: Number(sale.exchangeRate),
    cashierName: sale.cashierName,
    date: sale.date,
    refunded: Boolean(sale.refunded),
    items: itemsBySale.get(sale.id) || [],
  }));
}

export async function addSaleSql(sale: Omit<Sale, 'id'>): Promise<Sale> {
  const db = await getDb();

  const newSale: Sale = {
    ...sale,
    id: generateId(),
  };

  await db.execute(
    `INSERT INTO sales 
    (id, subtotal, total, currency, exchangeRate, cashierName, date, refunded)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newSale.id,
      newSale.subtotal,
      newSale.total,
      newSale.currency,
      newSale.exchangeRate,
      newSale.cashierName,
      newSale.date,
      newSale.refunded ? 1 : 0,
    ]
  );

  for (const item of newSale.items) {
    await db.execute(
      `INSERT INTO sale_items
      (id, saleId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        newSale.id,
        item.productId,
        item.productName,
        item.barcode,
        item.quantity,
        item.salePrice,
        item.purchasePrice,
        item.currency,
      ]
    );

    await updateProductStockSql(item.productId, -item.quantity);
  }

  return newSale;
}

export async function getExchangeRateSql(): Promise<number> {
  const db = await getDb();

  const rows = await db.select<{ value: string }[]>(
    'SELECT value FROM settings WHERE key = ? LIMIT 1',
    ['exchange_rate']
  );

  return rows[0] ? Number(rows[0].value) : 89500;
}

export async function setExchangeRateSql(rate: number): Promise<void> {
  const db = await getDb();

  await db.execute(
    `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
    ['exchange_rate', String(rate)]
  );
}

export async function getRefundsSql(): Promise<Refund[]> {
  const db = await getDb();

  const refunds = await db.select<any[]>(
    'SELECT * FROM refunds ORDER BY date DESC'
  );

  const refundItems = await db.select<any[]>(
    `SELECT refundId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency
     FROM refund_items`
  );

  const itemsByRefund = new Map<string, RefundItem[]>();

  for (const item of refundItems) {
    const refundId = item.refundId;

    if (!itemsByRefund.has(refundId)) {
      itemsByRefund.set(refundId, []);
    }

    itemsByRefund.get(refundId)!.push({
      productId: item.productId,
      productName: item.productName,
      barcode: item.barcode,
      quantity: Number(item.quantity),
      salePrice: Number(item.salePrice),
      purchasePrice: Number(item.purchasePrice),
      currency: item.currency,
    });
  }

  return refunds.map(refund => ({
    id: refund.id,
    saleId: refund.saleId,
    totalRefunded: Number(refund.totalRefunded),
    currency: refund.currency,
    date: refund.date,
    cashierName: refund.cashierName,
    items: itemsByRefund.get(refund.id) || [],
  }));
}
export async function addPartialRefundSql(
  saleId: string,
  refundItems: RefundItem[],
  cashierName: string
): Promise<Refund> {
  const db = await getDb();

  const sales = await getSalesSql();
  const sale = sales.find(s => s.id === saleId);

  if (!sale) throw new Error('Sale not found');

  const totalRefunded = refundItems.reduce(
    (sum, item) => sum + item.salePrice * item.quantity,
    0
  );

  const newRefund: Refund = {
    id: generateId(),
    saleId,
    items: refundItems,
    totalRefunded:
      sale.currency === 'USD'
        ? totalRefunded
        : totalRefunded * sale.exchangeRate,
    currency: sale.currency,
    date: new Date().toISOString(),
    cashierName,
  };

  await db.execute(
    `INSERT INTO refunds
     (id, saleId, totalRefunded, currency, date, cashierName)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newRefund.id,
      newRefund.saleId,
      newRefund.totalRefunded,
      newRefund.currency,
      newRefund.date,
      newRefund.cashierName,
    ]
  );

  for (const item of refundItems) {
    await db.execute(
      `INSERT INTO refund_items
       (id, refundId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        newRefund.id,
        item.productId,
        item.productName,
        item.barcode,
        item.quantity,
        item.salePrice,
        item.purchasePrice,
        item.currency,
      ]
    );

    await updateProductStockSql(item.productId, item.quantity);
  }

  for (const item of refundItems) {
    const saleItem = sale.items.find(i => i.productId === item.productId);
    if (saleItem) {
      saleItem.quantity -= item.quantity;
    }
  }

  sale.items = sale.items.filter(i => i.quantity > 0);
  sale.refunded = sale.items.length === 0;

  const newSubtotal = sale.items.reduce(
    (sum, item) => sum + item.salePrice * item.quantity,
    0
  );

  sale.subtotal = newSubtotal;
  sale.total =
    sale.currency === 'USD'
      ? newSubtotal
      : newSubtotal * sale.exchangeRate;

  await db.execute(
    `UPDATE sales
     SET subtotal = ?, total = ?, refunded = ?
     WHERE id = ?`,
    [sale.subtotal, sale.total, sale.refunded ? 1 : 0, sale.id]
  );

  await db.execute('DELETE FROM sale_items WHERE saleId = ?', [sale.id]);

  for (const item of sale.items) {
    await db.execute(
      `INSERT INTO sale_items
       (id, saleId, productId, productName, barcode, quantity, salePrice, purchasePrice, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        generateId(),
        sale.id,
        item.productId,
        item.productName,
        item.barcode,
        item.quantity,
        item.salePrice,
        item.purchasePrice,
        item.currency,
      ]
    );
  }

  return newRefund;
}

export async function updateProductSql(
  id: string,
  updates: Partial<Product>
): Promise<void> {
  const db = await getDb();

  const current = await db.select<Product[]>(
    'SELECT * FROM products WHERE id = ? LIMIT 1',
    [id]
  );

  if (!current[0]) throw new Error('Product not found');

  const updated = { ...current[0], ...updates };

  await db.execute(
    `UPDATE products
     SET barcode = ?, name = ?, stockQuantity = ?, purchasePrice = ?, salePrice = ?
     WHERE id = ?`,
    [
      updated.barcode,
      updated.name,
      updated.stockQuantity,
      updated.purchasePrice,
      updated.salePrice,
      id,
    ]
  );
}

export async function deleteProductSql(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM products WHERE id = ?', [id]);
}

export async function getInventoryEntriesSql(): Promise<InventoryEntry[]> {
  const db = await getDb();

  return await db.select<InventoryEntry[]>(
    'SELECT * FROM inventory_entries ORDER BY date DESC'
  );
}

export async function updateLatestInventoryEntrySalesmanSql(
  barcode: string,
  salesmanName: string
): Promise<void> {
  const db = await getDb();

  const entries = await db.select<{ id: string }[]>(
    `SELECT id FROM inventory_entries
     WHERE barcode = ?
     ORDER BY date DESC
     LIMIT 1`,
    [barcode]
  );

  if (!entries[0]) return;

  await db.execute(
    'UPDATE inventory_entries SET salesmanName = ? WHERE id = ?',
    [salesmanName, entries[0].id]
  );
}

export async function addInventoryEntrySql(
  entry: Omit<InventoryEntry, 'id'>
): Promise<InventoryEntry> {
  const db = await getDb();

  let productId = entry.productId;

  const existingProducts = await db.select<Product[]>(
    'SELECT * FROM products WHERE barcode = ? LIMIT 1',
    [entry.barcode]
  );

  if (existingProducts.length > 0) {
    productId = existingProducts[0].id;

    await db.execute(
      `UPDATE products
       SET name = ?, stockQuantity = stockQuantity + ?, purchasePrice = ?, salePrice = ?
       WHERE id = ?`,
      [
        entry.productName,
        Number(entry.quantityAdded),
        Number(entry.purchasePrice),
        Number(entry.salePrice),
        productId,
      ]
    );
  } else {
    productId = generateId();

    await db.execute(
      `INSERT INTO products
       (id, barcode, name, stockQuantity, purchasePrice, salePrice)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        productId,
        entry.barcode,
        entry.productName,
        Number(entry.quantityAdded),
        Number(entry.purchasePrice),
        Number(entry.salePrice),
      ]
    );
  }

  const newEntry: InventoryEntry = {
    ...entry,
    id: generateId(),
    productId,
  };

  await db.execute(
    `INSERT INTO inventory_entries
     (id, productId, productName, barcode, quantityAdded, purchasePrice, salePrice, salesmanName, date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newEntry.id,
      newEntry.productId,
      newEntry.productName,
      newEntry.barcode,
      Number(newEntry.quantityAdded),
      Number(newEntry.purchasePrice),
      Number(newEntry.salePrice),
      newEntry.salesmanName,
      newEntry.date,
    ]
  );

  return newEntry;
}

export async function getUsersSql(): Promise<User[]> {
  const db = await getDb();
  return await db.select<User[]>('SELECT * FROM users ORDER BY name ASC');
}

export async function addUserSql(user: Omit<User, 'id'>): Promise<User> {
  const db = await getDb();

  const newUser: User = {
    ...user,
    id: generateId(),
  };

  await db.execute(
    `INSERT INTO users (id, username, password, role, name)
     VALUES (?, ?, ?, ?, ?)`,
    [newUser.id, newUser.username, newUser.password, newUser.role, newUser.name]
  );

  return newUser;
}

export async function deleteUserSql(id: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM users WHERE id = ?', [id]);
}

export async function loginSql(username: string, password: string): Promise<User | null> {
  const db = await getDb();

  const users = await db.select<User[]>(
    'SELECT * FROM users WHERE username = ? AND password = ? LIMIT 1',
    [username, password]
  );

  return users[0] || null;
}