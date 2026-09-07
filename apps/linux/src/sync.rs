//! Sync engine: WiFi LAN mesh + Bluetooth fan-out + optional cloud relay.
//!
//! Default mode is **direct LAN sync, no cloud**: every Linux node keeps a
//! full ciphertext replica and serves it (`GET /lan/v1/items`), phones push
//! to it and poll it, and Linux nodes relay for each other. Identity in this
//! mode is derived from the shared sync key (`lan_owner_id`), so no account
//! server is needed at all. The cloud relay (`UCM_CLOUD_ENABLED=true`) is an
//! opt-in backstop for devices off the LAN.
//! Every transport carries the same E2E ciphertext; the engine decrypts only
//! on apply, so LAN/BT peers and the server all stay opaque to contents.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::{
    bluetooth,
    clipboard::ClipboardText,
    config::Config,
    crypto,
    db::Db,
    lan::{self, LanEnvelope, LanItem, PeerRegistry},
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub user_id: String,
    pub token: String,
    pub device_id: String,
}

/// Key-derived owner id for serverless LAN mode. Deterministic in the shared
/// sync key, so every device holding the same key lands in the same owner
/// namespace with zero coordination. MUST match `lanOwnerId` in
/// `apps/android/lib/crypto.ts`: `local-` + STANDARD-base64(key) with `=`
/// stripped and `+/` mapped to `-_` (URL-safe, no padding).
pub fn lan_owner_id(key: &[u8; 32]) -> String {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let clean: String = B64
        .encode(key)
        .chars()
        .filter(|&c| c != '=')
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            c => c,
        })
        .collect();
    format!("local-{clean}")
}

/// Serverless session: owner derived from the key, device id persisted in
/// the local db (stable across restarts so loop-prevention holds).
pub fn local_session(db: &Db, key: &[u8; 32]) -> anyhow::Result<SessionState> {
    let device_id = match db.get("device_id")? {
        Some(id) => id,
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db.set("device_id", &id)?;
            id
        }
    };
    Ok(SessionState { user_id: lan_owner_id(key), token: String::new(), device_id })
}

pub struct Engine {
    cfg: Config,
    key: [u8; 32],
    http: reqwest::Client,
    /// Dedup/loop-prevention state shared by the cloud, LAN, and BT tasks
    /// (all three borrow `&self`, so this uses interior mutability).
    shared: std::sync::Arc<tokio::sync::Mutex<Shared>>,
    lan_peers: Option<PeerRegistry>,
}

#[derive(Debug, Default)]
struct Shared {
    seen_ids: HashSet<String>, // loop/dup prevention
    last_local_text: Option<String>,
}

impl Engine {
    pub fn new(cfg: Config, key: [u8; 32]) -> Self {
        Self { cfg, key, http: reqwest::Client::new(), shared: Default::default(), lan_peers: None }
    }

    /// Attach the LAN peer registry so local copies also fan out over WiFi.
    pub fn with_lan(mut self, registry: PeerRegistry) -> Self {
        self.lan_peers = Some(registry);
        self
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
            .json(&serde_json::json!({"name": self.cfg.device_name, "platform": "linux", "public_key": "v1-placeholder", "capabilities": self.cfg.capabilities()}))
            .send().await?.error_for_status()?.json().await?;
        let device_id = res["id"].as_str().unwrap_or_default().to_string();
        db.set("user_id", &user_id)?; db.set("token", &token)?; db.set("device_id", &device_id)?;
        info!(device = %device_id, "paired new linux device");
        Ok(SessionState { user_id, token, device_id })
    }

    /// Handle a local clipboard change: encrypt + store + fan out.
    /// Fan-out order: WiFi LAN broadcast, Bluetooth staging, then cloud
    /// upload (only when `UCM_CLOUD_ENABLED=true`). The global pause switch
    /// (`sync_enabled`) gates every transport; capture always continues.
    pub async fn on_local_copy(&self, db: &Db, sess: &SessionState, text: ClipboardText) -> anyhow::Result<()> {
        {
            let shared = self.shared.lock().await;
            if Some(&text.0) == shared.last_local_text.as_ref() {
                return Ok(()); // loop guard
            }
        }
        if text.0.is_empty() || text.0.len() > 60_000 { return Ok(()); }
        let id = uuid::Uuid::new_v4().to_string();
        let created_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (ciphertext, nonce) = crypto::encrypt(&self.key, &text.0, &id, &sess.user_id, &sess.device_id, &created_at)?;
        db.insert(&crate::db::LocalItem {
            id: id.clone(), ciphertext: ciphertext.clone(), nonce: nonce.clone(),
            created_at: created_at.clone(), owner_id: sess.user_id.clone(),
            source_device_id: sess.device_id.clone(), uploaded: false, pinned: false,
        })?;
        {
            let mut shared = self.shared.lock().await;
            shared.seen_ids.insert(id.clone());
            shared.last_local_text = Some(text.0);
        }
        if self.cfg.cloud_enabled && self.cfg.sync_enabled {
            self.upload_with_backoff(sess, &id, &ciphertext, &nonce, &created_at).await?;
            db.mark_uploaded(&id)?;
        }
        // WiFi LAN fan-out (best-effort; missed peers catch up via replica poll).
        if self.cfg.wifi_enabled && self.cfg.sync_enabled {
            if let Some(reg) = self.lan_peers.clone() {
                let env = LanEnvelope::new_wifi(
                    &sess.device_id,
                    &self.cfg.device_name,
                    LanItem {
                        id: id.clone(),
                        owner_id: sess.user_id.clone(),
                        source_device_id: sess.device_id.clone(),
                        content_type: "text/plain".into(),
                        ciphertext: ciphertext.clone(),
                        nonce: nonce.clone(),
                        metadata: serde_json::json!({}),
                        created_at: created_at.clone(),
                        expires_at: None,
                        deleted_at: None,
                    },
                );
                let (ok, total) = lan::broadcast(&reg, &env).await;
                if total > 0 {
                    info!(delivered = ok, peers = total, "lan broadcast");
                }
            }
        }
        if self.cfg.bt_enabled && self.cfg.sync_enabled {
            // Framing check now; actual radio write happens on the connected
            // stream. Keeps a misconfigured BT stack from breaking capture.
            let bt_env = LanEnvelope {
                v: 1,
                transport: "bluetooth".into(),
                sender_device_id: sess.device_id.clone(),
                sender_name: Some(self.cfg.device_name.clone()),
                item: LanItem {
                    id: id.clone(),
                    owner_id: sess.user_id.clone(),
                    source_device_id: sess.device_id.clone(),
                    content_type: "text/plain".into(),
                    ciphertext,
                    nonce,
                    metadata: serde_json::json!({}),
                    created_at,
                    expires_at: None,
                    deleted_at: None,
                },
            };
            match bluetooth::encode_frames(&bt_env) {
                Ok(frames) => info!(frames = frames.len(), "bt envelope staged"),
                Err(e) => warn!(error = %e, "bt framing failed"),
            }
        }
        Ok(())
    }

    async fn upload_with_backoff(&self, sess: &SessionState, id: &str, ciphertext: &str, nonce: &str, created_at: &str) -> anyhow::Result<()> {
        let mut delay = Duration::from_millis(500);
        for attempt in 0..6 {
            let r = self.http.post(format!("{}/v1/items", self.base()))
                .bearer_auth(&sess.token)
                // created_at MUST be sent: it is bound into the AES-GCM AAD at
                // encrypt time and the server preserves it verbatim so other
                // devices can decrypt.
                .json(&serde_json::json!({"id": id, "content_type": "text/plain", "ciphertext": ciphertext, "nonce": nonce, "metadata": {}, "created_at": created_at}))
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
            match self.upload_with_backoff(sess, &item.id, &item.ciphertext, &item.nonce, &item.created_at).await {
                Ok(()) => { db.mark_uploaded(&item.id)?; n += 1; }
                Err(e) => { warn!(id = %item.id, error = %e, "flush item failed, will retry later"); break; }
            }
        }
        Ok(n)
    }

    /// Apply a remote item: decrypt + write to local clipboard (origin-tagged
    /// to avoid loops) + store in the replica so LAN pollers get it too.
    pub async fn apply_remote(
        &self,
        db: &Db,
        writer: &dyn crate::clipboard::ClipboardProvider,
        sess: &SessionState,
        item_id: &str,
        ciphertext: &str,
        nonce: &str,
        source_device: &str,
        created_at: &str,
    ) -> anyhow::Result<()> {
        {
            let mut shared = self.shared.lock().await;
            if !shared.seen_ids.insert(item_id.to_string()) {
                return Ok(()); // duplicate delivery
            }
        }
        if source_device == sess.device_id { return Ok(()); } // own echo
        let pt = crypto::decrypt(&self.key, ciphertext, nonce, item_id, &sess.user_id, source_device, created_at)?;
        writer.write(&pt).await?;
        self.shared.lock().await.last_local_text = Some(pt);
        // Replica: this node can now serve the item to LAN pollers (phones).
        // `uploaded=true`: it originated elsewhere, nothing to relay upstream.
        db.insert(&crate::db::LocalItem {
            id: item_id.to_string(), ciphertext: ciphertext.to_string(), nonce: nonce.to_string(),
            created_at: created_at.to_string(), owner_id: sess.user_id.clone(),
            source_device_id: source_device.to_string(), uploaded: true, pinned: false,
        })?;
        Ok(())
    }

    /// Apply a P2P envelope (WiFi LAN or Bluetooth): same decrypt + write
    /// path as cloud items. Foreign-owner envelopes are ignored — without a
    /// server there is no account auth, so the owner namespace (session user
    /// or key-derived `local-…`) must match on both sides, i.e. the same
    /// sync key. Anything decryptable with our key but another owner is
    /// someone else's clipboard, never ours.
    pub async fn apply_lan_envelope(
        &self,
        db: &Db,
        writer: &dyn crate::clipboard::ClipboardProvider,
        sess: &SessionState,
        env: &LanEnvelope,
    ) -> anyhow::Result<bool> {
        lan::validate_envelope(env)?;
        if env.item.owner_id != sess.user_id {
            warn!(sender = %env.sender_device_id, "lan envelope from another key/account ignored");
            return Ok(false);
        }
        self.apply_remote(
            db,
            writer,
            sess,
            &env.item.id,
            &env.item.ciphertext,
            &env.item.nonce,
            &env.item.source_device_id,
            &env.item.created_at,
        )
        .await?;
        Ok(true)
    }

    /// Main loop: clipboard watch + LAN mesh (+ cloud WS/queue when enabled).
    pub async fn run(
        self,
        db: Db,
        reader: Box<dyn crate::clipboard::ClipboardProvider>,
        writer: Box<dyn crate::clipboard::ClipboardProvider>,
    ) -> anyhow::Result<()> {
        // Identity: cloud account when the relay is enabled, otherwise the
        // key-derived LAN namespace (no server contact at all).
        let sess = if self.cfg.cloud_enabled {
            let s = self.ensure_session(&db).await?;
            let n = self.flush_queue(&db, &s).await.unwrap_or(0);
            info!(flushed = n, "cloud relay enabled");
            s
        } else {
            info!("cloud relay disabled (UCM_CLOUD_ENABLED=true to enable) — direct LAN/BT mode");
            local_session(&db, &self.key)?
        };

        // WiFi LAN wiring (registry shared with the broadcast path above).
        let lan_registry: PeerRegistry = match &self.lan_peers {
            Some(r) => r.clone(),
            None => lan::new_registry(),
        };
        let (lan_tx, mut lan_rx) = mpsc::channel::<LanEnvelope>(32);
        if self.cfg.wifi_enabled {
            let beacon = lan::local_beacon(
                &sess.device_id,
                &self.cfg.device_name,
                self.cfg.lan_port,
                self.cfg.capabilities(),
            );
            let announce_beacon = beacon.clone();
            let discovery_port = self.cfg.discovery_port;
            let lan_port = self.cfg.lan_port;
            let reg = lan_registry.clone();
            let own = sess.device_id.clone();
            let db_path = format!("{}/history.db", self.cfg.data_dir);
            tokio::spawn(async move { let _ = lan::announce_loop(announce_beacon, discovery_port).await; });
            tokio::spawn(async move { let _ = lan::discover_loop(reg, own, discovery_port).await; });
            tokio::spawn(async move { let _ = lan::serve(lan_port, lan_tx, db_path).await; });
            info!(port = lan_port, "wifi-lan mesh enabled (serve + discover + broadcast)");
        }
        if self.cfg.bt_enabled {
            let st = bluetooth::availability();
            info!(available = st.available, powered = st.powered, detail = %st.detail, "bluetooth transport");
        }

        let (tx, mut rx) = mpsc::channel::<ClipboardText>(32);
        let reader_task = {
            let tx = tx.clone();
            async move { reader.watch(tx).await }
        };
        let ws_url = format!("{}/v1/sync?token={}", self.base().replace("http", "ws"), sess.token);
        let cloud_enabled = self.cfg.cloud_enabled;
        let ws_task = async {
            if !cloud_enabled {
                // Never resolve: cloud stays out of the select set entirely.
                futures_util::future::pending::<()>().await;
                return;
            }
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
                                            let _ = self.apply_remote(&db, &*writer,
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
        // LAN inbox: decrypt + write to clipboard with the same loop guards.
        let lan_task = async {
            loop {
                if let Some(env) = lan_rx.recv().await {
                    let _ = self.apply_lan_envelope(&db, &*writer, &sess, &env).await;
                }
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
            _ = lan_task => {},
        }
        Ok(())
    }
}
