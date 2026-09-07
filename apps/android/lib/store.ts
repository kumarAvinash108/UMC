import * as SQLite from "expo-sqlite";

/** Local history + offline queue (plaintext only after local decrypt). */
let db: SQLite.SQLiteDatabase | null = null;

export async function getDb() {
  if (!db) {
    db = await SQLite.openDatabaseAsync("ucm.db");
    await db.execAsync(
      `CREATE TABLE IF NOT EXISTS items(
         id TEXT PRIMARY KEY, plaintext TEXT NOT NULL, source_device TEXT NOT NULL,
         created_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
       CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC, id DESC);`
    );
  }
  return db;
}

export interface LocalRow {
  id: string;
  plaintext: string;
  source_device: string;
  created_at: string;
  pinned: number;
  pending: number;
}

export async function upsertRow(row: LocalRow) {
  const d = await getDb();
  await d.runAsync(
    `INSERT INTO items(id,plaintext,source_device,created_at,pinned,pending) VALUES(?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET plaintext=excluded.plaintext`,
    [row.id, row.plaintext, row.source_device, row.created_at, row.pinned, row.pending]
  );
}

export async function searchRows(q: string, limit = 100): Promise<LocalRow[]> {
  const d = await getDb();
  if (!q) return d.getAllAsync<LocalRow>(`SELECT * FROM items ORDER BY pinned DESC, created_at DESC, id DESC LIMIT ?`, [limit]);
  return d.getAllAsync<LocalRow>(
    `SELECT * FROM items WHERE plaintext LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT ?`,
    [`%${q}%`, limit]
  );
}

export async function setPinned(id: string, pinned: boolean) {
  const d = await getDb();
  await d.runAsync(`UPDATE items SET pinned=? WHERE id=?`, [pinned ? 1 : 0, id]);
}

export async function deleteRow(id: string) {
  const d = await getDb();
  await d.runAsync(`DELETE FROM items WHERE id=?`, [id]);
}
