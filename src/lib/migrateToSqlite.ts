import { invoke } from '@tauri-apps/api/core';

function records(key: string): unknown[] {
  const raw = localStorage.getItem(key);
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error(`Invalid legacy data in ${key}; original data retained`);
  return value;
}

export async function migrateLocalStorageToSqlite(): Promise<boolean> {
  const alreadyMigrated = localStorage.getItem('pos_migrated_to_sqlite') === 'true';
  const rawRate = alreadyMigrated ? null : localStorage.getItem('pos_exchange_rate');
  const exchangeRate: unknown = rawRate === null ? null : JSON.parse(rawRate);
  if (exchangeRate !== null && (typeof exchangeRate !== 'number' || !Number.isFinite(exchangeRate) || exchangeRate <= 0)) {
    throw new Error('Invalid legacy exchange rate; original data retained');
  }
  // A single native connection owns the transaction and durable marker.
  // Transactions across separate plugin-sql pooled calls are unsafe.
  const needsAdmin = await invoke<boolean>('initialize_database', {
    legacy: {
      alreadyMigrated,
      users: alreadyMigrated ? [] : records('pos_users'),
      products: alreadyMigrated ? [] : records('pos_products'),
      sales: alreadyMigrated ? [] : records('pos_sales'),
      refunds: alreadyMigrated ? [] : records('pos_refunds'),
      inventoryEntries: alreadyMigrated ? [] : records('pos_inventory_entries'),
      exchangeRate,
    },
  });
  // Retain all original data; record success only after native commit.
  // SQLite's own import marker is authoritative. A full legacy Web Storage
  // must not prevent startup AFTER the native transaction was committed.
  if (!alreadyMigrated) {
    try { localStorage.setItem('pos_migrated_to_sqlite', 'true'); }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'QuotaExceededError') throw error;
      console.warn('Legacy Web Storage is full; native SQLite import is committed and originals are retained.');
    }
  }
  return needsAdmin;
}
