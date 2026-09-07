//! Local encrypted SQLite history + offline upload queue.
//!
//! Every row carries the AAD identity (`owner_id`, `source_device_id`) so a
//! Linux node can SERVE its full replica over WiFi LAN (`GET
//! /lan/v1/items`): polling peers (Android) get exactly the bytes the
//! encryptor produced. Rows predating these columns (empty owner) are kept
//! for local history but never served.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalItem {
    pub id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub created_at: String,
    /// AAD owner (account user_id, or key-derived `local-…` in LAN-only mode).
    pub owner_id: String,
    /// Device that produced the item (AAD-bound).
    pub source_device_id: String,
    pub uploaded: bool,
    pub pinned: bool,
}

pub struct Db {
    conn: Connection,
}

const SCHEMA_NEW: &str = "CREATE TABLE IF NOT EXISTS items(
   id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
   created_at TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT '',
   source_device_id TEXT NOT NULL DEFAULT '',
   uploaded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);";

fn migrate(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(SCHEMA_NEW)?;
    // Upgrade pre-mesh databases in place (old rows keep '' owner/source and
    // stay local-only: they are history, never served to LAN peers).
    for col in ["owner_id", "source_device_id"] {
        let has: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('items') WHERE name=?")?
            .query_row(params![col], |r| r.get::<_, i32>(0))
            .map(|n| n > 0)?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE items ADD COLUMN {col} TEXT NOT NULL DEFAULT '';"))?;
        }
    }
    Ok(())
}

impl Db {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE items(
               id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
               created_at TEXT NOT NULL, owner_id TEXT NOT NULL DEFAULT '',
               source_device_id TEXT NOT NULL DEFAULT '',
               uploaded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert(&self, item: &LocalItem) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO items(id,ciphertext,nonce,created_at,owner_id,source_device_id,uploaded,pinned) VALUES(?,?,?,?,?,?,?,?)",
            params![item.id, item.ciphertext, item.nonce, item.created_at, item.owner_id, item.source_device_id, item.uploaded as i32, item.pinned as i32],
        )?;
        Ok(())
    }

    pub fn mark_uploaded(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("UPDATE items SET uploaded=1 WHERE id=?", params![id])?;
        Ok(())
    }

    fn row(r: &rusqlite::Row) -> rusqlite::Result<LocalItem> {
        Ok(LocalItem {
            id: r.get(0)?, ciphertext: r.get(1)?, nonce: r.get(2)?,
            created_at: r.get(3)?, owner_id: r.get(4)?, source_device_id: r.get(5)?,
            uploaded: r.get::<_, i32>(6)? != 0, pinned: r.get::<_, i32>(7)? != 0,
        })
    }

    const COLS: &str = "id,ciphertext,nonce,created_at,owner_id,source_device_id,uploaded,pinned";

    pub fn pending(&self) -> anyhow::Result<Vec<LocalItem>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM items WHERE uploaded=0 ORDER BY created_at,id", Self::COLS))?;
        let rows = stmt.query_map([], Self::row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn recent(&self, limit: usize) -> anyhow::Result<Vec<LocalItem>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {} FROM items ORDER BY created_at DESC,id DESC LIMIT ?", Self::COLS))?;
        let rows = stmt.query_map(params![limit as i64], Self::row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Servable replica slice for LAN pollers: only rows with AAD identity,
    /// ascending `(created_at, id)`, strictly after the caller's cursor.
    pub fn list_since(&self, since: Option<(&str, &str)>, limit: usize) -> anyhow::Result<Vec<LocalItem>> {
        let limit = limit.clamp(1, 100) as i64;
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {} FROM items WHERE owner_id != '' AND source_device_id != ''
             AND (created_at > ? OR (created_at = ? AND id > ?))
             ORDER BY created_at,id LIMIT ?", Self::COLS))?;
        let (sc, si) = since.unwrap_or(("", ""));
        let rows = stmt.query_map(params![sc, sc, si, limit], Self::row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn get(&self, k: &str) -> anyhow::Result<Option<String>> {
        let mut stmt = self.conn.prepare("SELECT value FROM meta WHERE key=?")?;
        let mut rows = stmt.query(params![k])?;
        Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
    }

    pub fn set(&self, k: &str, v: &str) -> anyhow::Result<()> {
        self.conn.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![k, v])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(id: &str, ts: &str) -> LocalItem {
        LocalItem { id: id.into(), ciphertext: "Yg==".into(), nonce: "bg==".into(), created_at: ts.into(), owner_id: "u".into(), source_device_id: "d".into(), uploaded: false, pinned: false }
    }
    #[test]
    fn queue_roundtrip() {
        let db = Db::open_memory().unwrap();
        assert!(db.pending().unwrap().is_empty());
        db.insert(&item("a", "2024-01-01T00:00:00Z")).unwrap();
        assert_eq!(db.pending().unwrap().len(), 1);
        db.mark_uploaded("a").unwrap();
        assert!(db.pending().unwrap().is_empty());
    }

    #[test]
    fn since_pagination_skips_legacy_rows() {
        let db = Db::open_memory().unwrap();
        db.insert(&item("a", "2024-01-01T00:00:00.000Z")).unwrap();
        db.insert(&item("b", "2024-01-01T00:00:01.000Z")).unwrap();
        db.insert(&LocalItem { owner_id: "".into(), source_device_id: "".into(), ..item("old", "2024-06-01T00:00:00.000Z") }).unwrap();
        let all = db.list_since(None, 100).unwrap();
        assert_eq!(all.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        let page = db.list_since(Some(("2024-01-01T00:00:00.000Z", "a")), 100).unwrap();
        assert_eq!(page.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
        assert!(db.list_since(Some(("2024-01-01T00:00:01.000Z", "b")), 100).unwrap().is_empty());
    }
}
