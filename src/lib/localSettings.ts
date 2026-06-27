export async function getSetting(db: any, key: string) {
  const rows = await db.select(
    "SELECT value FROM settings WHERE key = ?",
    [key]
  );

  return rows?.[0]?.value ?? null;
}

export async function setSetting(db: any, key: string, value: string) {
  await db.execute(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    [key, value]
  );
}