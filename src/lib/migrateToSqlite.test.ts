import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { migrateLocalStorageToSqlite } from './migrateToSqlite';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('original customer migration boundary', () => {
  beforeEach(() => { localStorage.clear(); vi.resetAllMocks(); });

  it('retains originals and marks success after native commit', async () => {
    const products = JSON.stringify([{ id: 'original-product', stockQuantity: 12 }]);
    localStorage.setItem('pos_products', products);
    vi.mocked(invoke).mockResolvedValue(false);
    await migrateLocalStorageToSqlite();
    expect(invoke).toHaveBeenCalledWith('initialize_database', expect.objectContaining({
      legacy: expect.objectContaining({ products: JSON.parse(products), alreadyMigrated: false }),
    }));
    expect(localStorage.getItem('pos_products')).toBe(products);
    expect(localStorage.getItem('pos_migrated_to_sqlite')).toBe('true');
  });

  it.each(['{broken', '{}', 'null'])('refuses corrupt legacy records: %s', async raw => {
    localStorage.setItem('pos_sales', raw);
    await expect(migrateLocalStorageToSqlite()).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem('pos_sales')).toBe(raw);
    expect(localStorage.getItem('pos_migrated_to_sqlite')).toBeNull();
  });

  it('retains retry eligibility after native rollback', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('conflict'));
    await expect(migrateLocalStorageToSqlite()).rejects.toThrow('conflict');
    expect(localStorage.getItem('pos_migrated_to_sqlite')).toBeNull();
  });

  it('does not replay a completed legacy import', async () => {
    localStorage.setItem('pos_migrated_to_sqlite', 'true');
    localStorage.setItem('pos_sales', '{old malformed backup');
    vi.mocked(invoke).mockResolvedValue(false);
    await migrateLocalStorageToSqlite();
    expect(invoke).toHaveBeenCalledWith('initialize_database', expect.objectContaining({
      legacy: expect.objectContaining({ alreadyMigrated: true, sales: [] }),
    }));
  });
  it('continues after a committed native import when the legacy marker cannot fit in Web Storage', async () => {
    localStorage.setItem('pos_sales','[]');vi.mocked(invoke).mockResolvedValue(false);
    const spy=vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw new DOMException('Full','QuotaExceededError');});
    try {await expect(migrateLocalStorageToSqlite()).resolves.toBe(false);expect(localStorage.getItem('pos_sales')).toBe('[]');}
    finally {spy.mockRestore();}
  });
});
