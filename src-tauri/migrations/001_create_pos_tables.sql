CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    barcode TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    stockQuantity INTEGER NOT NULL,
    purchasePrice REAL NOT NULL,
    salePrice REAL NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales (
    id TEXT PRIMARY KEY,
    subtotal REAL NOT NULL,
    total REAL NOT NULL,
    currency TEXT NOT NULL,
    exchangeRate REAL NOT NULL,
    cashierName TEXT NOT NULL,
    date TEXT NOT NULL,
    refunded INTEGER NOT NULL DEFAULT 0,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sale_items (
    id TEXT PRIMARY KEY,
    saleId TEXT NOT NULL,
    productId TEXT NOT NULL,
    productName TEXT NOT NULL,
    barcode TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    salePrice REAL NOT NULL,
    purchasePrice REAL NOT NULL,
    currency TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refunds (
    id TEXT PRIMARY KEY,
    saleId TEXT NOT NULL,
    totalRefunded REAL NOT NULL,
    currency TEXT NOT NULL,
    date TEXT NOT NULL,
    cashierName TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS refund_items (
    id TEXT PRIMARY KEY,
    refundId TEXT NOT NULL,
    productId TEXT NOT NULL,
    productName TEXT NOT NULL,
    barcode TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    salePrice REAL NOT NULL,
    purchasePrice REAL NOT NULL,
    currency TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inventory_entries (
    id TEXT PRIMARY KEY,
    productId TEXT NOT NULL,
    productName TEXT NOT NULL,
    barcode TEXT NOT NULL,
    quantityAdded INTEGER NOT NULL,
    purchasePrice REAL NOT NULL,
    salePrice REAL NOT NULL,
    salesmanName TEXT NOT NULL,
    date TEXT NOT NULL,
    synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
