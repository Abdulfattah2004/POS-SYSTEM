import { afterEach, expect, it, vi } from 'vitest';
import { createAuthStorage } from './authStorage';
afterEach(() => vi.restoreAllMocks());
it('persists and refreshes tokens with full legacy localStorage without removing any keys', async () => {
  const key = 'sb-quota-fixture-auth-token';
  localStorage.setItem('pos_sales', JSON.stringify(Array.from({length:22220}, (_,id)=>({id}))));
  const original = localStorage.getItem('pos_sales');
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
  const remove = vi.spyOn(Storage.prototype, 'removeItem'); const clear = vi.spyOn(Storage.prototype, 'clear');
  const first = createAuthStorage(); await first.setItem(key, 'session-one');
  expect(await createAuthStorage().getItem(key)).toBe('session-one');
  await first.setItem(key, 'session-refreshed'); expect(await createAuthStorage().getItem(key)).toBe('session-refreshed');
  await first.removeItem(key); expect(await createAuthStorage().getItem(key)).toBeNull();
  expect(localStorage.getItem('pos_sales')).toBe(original);
  expect(set).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
});
it('imports an existing auth token without deleting it and never resurrects it after logout', async () => {
  const key='sb-import-fixture-auth-token'; localStorage.setItem(key, 'old-token');
  const storage=createAuthStorage(); expect(await storage.getItem(key)).toBe('old-token');
  await storage.removeItem(key); expect(await createAuthStorage().getItem(key)).toBeNull();
  expect(localStorage.getItem(key)).toBe('old-token');
  await storage.setItem(key,'reconnected-token'); expect(await createAuthStorage().getItem(key)).toBe('reconnected-token');
});
