import type Database from '@tauri-apps/plugin-sql';
export async function getSetting(db: Database, key: string) {
  const rows = await db.select<{value:string}[]>(
    "SELECT value FROM settings WHERE key = ?",
    [key]
  );

  return rows?.[0]?.value ?? null;
}

export async function setSetting(db: Database, key: string, value: string) {
  await db.execute(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [key, value]
  );
}
