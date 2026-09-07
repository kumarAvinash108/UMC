//! Local encrypted SQLite history + offline upload queue.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalItem {
    pub id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub created_at: String,
    pub uploaded: bool,
    pub pinned: bool,
}

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: &str) -> anyhow::Result<Self> {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS items(
               id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
               created_at TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { conn })
    }

    pub fn open_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(
            "CREATE TABLE items(
               id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL,
               created_at TEXT NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        Ok(Self { conn })
    }

    pub fn insert(&self, item: &LocalItem) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO items(id,ciphertext,nonce,created_at,uploaded,pinned) VALUES(?,?,?,?,?,?)",
            params![item.id, item.ciphertext, item.nonce, item.created_at, item.uploaded as i32, item.pinned as i32],
        )?;
        Ok(())
    }

    pub fn mark_uploaded(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("UPDATE items SET uploaded=1 WHERE id=?", params![id])?;
        Ok(())
    }

    pub fn pending(&self) -> anyhow::Result<Vec<LocalItem>> {
        let mut stmt = self.conn.prepare("SELECT id,ciphertext,nonce,created_at,uploaded,pinned FROM items WHERE uploaded=0 ORDER BY created_at,id")?;
        let rows = stmt.query_map([], |r| {
            Ok(LocalItem {
                id: r.get(0)?, ciphertext: r.get(1)?, nonce: r.get(2)?,
                created_at: r.get(3)?, uploaded: r.get::<_, i32>(4)? != 0, pinned: r.get::<_, i32>(5)? != 0,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn recent(&self, limit: usize) -> anyhow::Result<Vec<LocalItem>> {
        let mut stmt = self.conn.prepare("SELECT id,ciphertext,nonce,created_at,uploaded,pinned FROM items ORDER BY created_at DESC,id DESC LIMIT ?")?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(LocalItem {
                id: r.get(0)?, ciphertext: r.get(1)?, nonce: r.get(2)?,
                created_at: r.get(3)?, uploaded: r.get::<_, i32>(4)? != 0, pinned: r.get::<_, i32>(5)? != 0,
            })
        })?;
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
    #[test]
    fn queue_roundtrip() {
        let db = Db::open_memory().unwrap();
        assert!(db.pending().unwrap().is_empty());
        db.insert(&LocalItem { id: "a".into(), ciphertext: "Yg==".into(), nonce: "bg==".into(), created_at: "2024-01-01T00:00:00Z".into(), uploaded: false, pinned: false }).unwrap();
        assert_eq!(db.pending().unwrap().len(), 1);
        db.mark_uploaded("a").unwrap();
        assert!(db.pending().unwrap().is_empty());
    }
}
