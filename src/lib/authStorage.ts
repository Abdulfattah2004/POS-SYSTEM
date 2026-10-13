// Auth has its own IndexedDB store: retained legacy localStorage may be full.
// Never evict legacy business records or fall back to quota-limited token writes.
export function createAuthStorage() {
  const database = () => new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Persistent cloud sign-in storage is unavailable. Offline POS data is unchanged.')); return; }
    const request = indexedDB.open('swift-till-cloud-auth', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('sessions');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Cannot open persistent cloud sign-in storage. Offline POS data is unchanged.'));
    request.onblocked = () => reject(new Error('Close other POS windows before reconnecting cloud authentication.'));
  });
  const read = async (key: string): Promise<{ value: string | null } | undefined> => {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', 'readonly');
      const request = tx.objectStore('sessions').get(key);
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Cannot read persistent cloud sign-in storage.')); };
    });
  };
  const write = async (key: string, value: string | null) => {
    const db = await database();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction('sessions', 'readwrite', { durability: 'strict' });
      tx.objectStore('sessions').put({ value }, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = tx.onabort = () => { db.close(); reject(new Error('Cloud sign-in could not be saved. Check available disk space; legacy POS data was not removed.')); };
    });
  };
  return {
    async getItem(key: string) {
      const saved = await read(key);
      if (saved !== undefined) return saved.value;
      // One-way import of an existing SDK token, without deleting its old key.
      // Explicit null tombstones prevent old tokens reappearing after logout.
      const legacy = globalThis.localStorage?.getItem(key) ?? null;
      if (legacy !== null) await write(key, legacy);
      return legacy;
    },
    setItem: write,
    removeItem: (key: string) => write(key, null),
  };
}
