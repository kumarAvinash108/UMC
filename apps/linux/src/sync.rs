//! Sync engine: backoff retries, idempotent uploads, WS fan-in, loop prevention.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::{clipboard::ClipboardText, config::Config, crypto, db::Db};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub user_id: String,
    pub token: String,
    pub device_id: String,
}

pub struct Engine {
    cfg: Config,
    key: [u8; 32],
    http: reqwest::Client,
    seen_ids: HashSet<String>, // loop/dup prevention
    last_local_text: Option<String>,
}

impl Engine {
    pub fn new(cfg: Config, key: [u8; 32]) -> Self {
        Self { cfg, key, http: reqwest::Client::new(), seen_ids: HashSet::new(), last_local_text: None }
    }

    fn base(&self) -> String {
        self.cfg.server_url.trim_end_matches('/').to_string()
    }

    pub async fn ensure_session(&self, db: &Db) -> anyhow::Result<SessionState> {
        if let (Some(user_id), Some(token), Some(device_id)) =
            (db.get("user_id")?, db.get("token")?, db.get("device_id")?)
        {
            return Ok(SessionState { user_id, token, device_id });
        }
        // Fresh pairing: create account + device.
        let res: serde_json::Value = self.http.post(format!("{}/v1/auth/session", self.base()))
            .json(&serde_json::json!({})).send().await?.error_for_status()?.json().await?;
        let user_id = res["user_id"].as_str().unwrap_or_default().to_string();
        let token = res["token"].as_str().unwrap_or_default().to_string();
        let res: serde_json::Value = self.http.post(format!("{}/v1/devices", self.base()))
            .bearer_auth(&token)
            .json(&serde_json::json!({"name": self.cfg.device_name, "platform": "linux", "public_key": "v1-placeholder"}))
            .send().await?.error_for_status()?.json().await?;
        let device_id = res["id"].as_str().unwrap_or_default().to_string();
        db.set("user_id", &user_id)?; db.set("token", &token)?; db.set("device_id", &device_id)?;
        info!(device = %device_id, "paired new linux device");
        Ok(SessionState { user_id, token, device_id })
    }

    /// Handle a local clipboard change: encrypt + queue + upload (if enabled).
    pub async fn on_local_copy(&mut self, db: &Db, sess: &SessionState, text: ClipboardText) -> anyhow::Result<()> {
        if Some(&text.0) == self.last_local_text.as_ref() { return Ok(()); } // loop guard
        if text.0.is_empty() || text.0.len() > 60_000 { return Ok(()); }
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (ciphertext, nonce) = crypto::encrypt(&self.key, &text.0, &id, &sess.user_id, &sess.device_id, &created_at)?;
        db.insert(&crate::db::LocalItem { id: id.clone(), ciphertext: ciphertext.clone(), nonce: nonce.clone(), created_at: created_at.clone(), uploaded: false, pinned: false })?;
        self.seen_ids.insert(id.clone());
        self.last_local_text = Some(text.0);
        if self.cfg.sync_enabled {
            self.upload_with_backoff(sess, &id, &ciphertext, &nonce).await?;
            db.mark_uploaded(&id)?;
        }
        Ok(())
    }

    async fn upload_with_backoff(&self, sess: &SessionState, id: &str, ciphertext: &str, nonce: &str) -> anyhow::Result<()> {
        let mut delay = Duration::from_millis(500);
        for attempt in 0..6 {
            let r = self.http.post(format!("{}/v1/items", self.base()))
                .bearer_auth(&sess.token)
                .json(&serde_json::json!({"id": id, "content_type": "text/plain", "ciphertext": ciphertext, "nonce": nonce, "metadata": {}}))
                .send().await;
            match r {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                Ok(resp) => warn!(attempt, status = %resp.status(), "upload failed, retrying"),
                Err(e) => warn!(attempt, error = %e, "upload error, retrying"),
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
        anyhow::bail!("upload failed after retries (kept in offline queue)")
    }

    /// Replay offline queue in order.
    pub async fn flush_queue(&self, db: &Db, sess: &SessionState) -> anyhow::Result<usize> {
        let pending = db.pending()?;
        let mut n = 0;
        for item in pending {
            match self.upload_with_backoff(sess, &item.id, &item.ciphertext, &item.nonce).await {
                Ok(()) => { db.mark_uploaded(&item.id)?; n += 1; }
                Err(e) => { warn!(id = %item.id, error = %e, "flush item failed, will retry later"); break; }
            }
        }
        Ok(n)
    }

    /// Apply a remote item: decrypt + write to local clipboard (origin-tagged to avoid loops).
    pub async fn apply_remote(
        &mut self,
        writer: &dyn crate::clipboard::ClipboardProvider,
        sess: &SessionState,
        item_id: &str,
        ciphertext: &str,
        nonce: &str,
        source_device: &str,
        created_at: &str,
    ) -> anyhow::Result<()> {
        if !self.seen_ids.insert(item_id.to_string()) { return Ok(()); } // duplicate delivery
        if source_device == sess.device_id { return Ok(()); } // own echo
        let pt = crypto::decrypt(&self.key, ciphertext, nonce, item_id, &sess.user_id, source_device, created_at)?;
        writer.write(&pt).await?;
        self.last_local_text = Some(pt);
        Ok(())
    }

    /// Main loop: watch clipboard + flush queue + WS live updates.
    pub async fn run(
        mut self,
        db: Db,
        reader: Box<dyn crate::clipboard::ClipboardProvider>,
        writer: Box<dyn crate::clipboard::ClipboardProvider>,
    ) -> anyhow::Result<()> {
        let sess = self.ensure_session(&db).await?;
        self.flush_queue(&db, &sess).await.unwrap_or(0);
        let (tx, mut rx) = mpsc::channel::<ClipboardText>(32);
        let reader_task = {
            let tx = tx.clone();
            async move { reader.watch(tx).await }
        };
        let ws_url = format!("{}/v1/sync?token={}", self.base().replace("http", "ws"), sess.token);
        let ws_task = async {
            loop {
                match tokio_tungstenite::connect_async(&ws_url).await {
                    Ok((stream, _)) => {
                        info!("ws connected");
                        let (_, mut read) = stream.split();
                        while let Some(msg) = read.next().await {
                            match msg {
                                Ok(m) if m.is_text() => {
                                    if let Ok(evt) = serde_json::from_str::<serde_json::Value>(m.to_text().unwrap_or_default()) {
                                        if evt["type"] == "item.created" {
                                            let it = &evt["item"];
                                            let _ = self.apply_remote(&*writer,
                                                &sess,
                                                it["id"].as_str().unwrap_or_default(),
                                                it["ciphertext"].as_str().unwrap_or_default(),
                                                it["nonce"].as_str().unwrap_or_default(),
                                                it["source_device_id"].as_str().unwrap_or_default(),
                                                it["created_at"].as_str().unwrap_or_default()).await;
                                        }
                                    }
                                }
                                _ => break, // reconnect with backoff
                            }
                        }
                    }
                    Err(e) => warn!(error = %e, "ws connect failed"),
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        };
        tokio::select! {
            r = reader_task => r?,
            _ = async {
                loop {
                    if let Some(text) = rx.recv().await {
                        let _ = self.on_local_copy(&db, &sess, text).await;
                    }
                }
            } => {},
            _ = ws_task => {},
        }
        Ok(())
    }
}
