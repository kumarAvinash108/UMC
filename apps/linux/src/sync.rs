//! Sync engine: cloud relay + WiFi LAN + Bluetooth fan-out, loop prevention.
//!
//! Transport priority is wifi-lan → bluetooth → cloud (see `transport.rs`).
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

    /// Handle a local clipboard change: encrypt + queue + fan out.
    /// Fan-out order: cloud upload (if enabled) then WiFi LAN broadcast.
    /// Bluetooth sending is staged via `bt_send_hint`: v1 logs the framed
    /// size and relies on the connected RFCOMM/GATT stream (see
    /// `bluetooth::send_over_stream`) — the envelope bytes are identical.
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
        db.insert(&crate::db::LocalItem { id: id.clone(), ciphertext: ciphertext.clone(), nonce: nonce.clone(), created_at: created_at.clone(), uploaded: false, pinned: false })?;
        {
            let mut shared = self.shared.lock().await;
            shared.seen_ids.insert(id.clone());
            shared.last_local_text = Some(text.0);
        }
        if self.cfg.sync_enabled {
            self.upload_with_backoff(sess, &id, &ciphertext, &nonce).await?;
            db.mark_uploaded(&id)?;
        }
        // WiFi LAN fan-out (best-effort; cloud/offline queue is the backstop).
        if self.cfg.wifi_enabled {
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
        if self.cfg.bt_enabled {
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
        &self,
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
        Ok(())
    }

    /// Apply a P2P envelope (WiFi LAN or Bluetooth): same decrypt + write
    /// path as cloud items. Cross-account envelopes are ignored — LAN has
    /// no server auth, so the owner_id must match our own user.
    pub async fn apply_lan_envelope(
        &self,
        writer: &dyn crate::clipboard::ClipboardProvider,
        sess: &SessionState,
        env: &LanEnvelope,
    ) -> anyhow::Result<bool> {
        lan::validate_envelope(env)?;
        if env.item.owner_id != sess.user_id {
            warn!(sender = %env.sender_device_id, "lan envelope from another account ignored");
            return Ok(false);
        }
        self.apply_remote(
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

    /// Main loop: clipboard watch + offline flush + cloud WS + LAN + BT status.
    pub async fn run(
        self,
        db: Db,
        reader: Box<dyn crate::clipboard::ClipboardProvider>,
        writer: Box<dyn crate::clipboard::ClipboardProvider>,
    ) -> anyhow::Result<()> {
        let sess = self.ensure_session(&db).await?;
        self.flush_queue(&db, &sess).await.unwrap_or(0);

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
            tokio::spawn(async move { let _ = lan::announce_loop(announce_beacon, discovery_port).await; });
            tokio::spawn(async move { let _ = lan::discover_loop(reg, own, discovery_port).await; });
            tokio::spawn(async move { let _ = lan::serve(lan_port, lan_tx).await; });
            info!(port = lan_port, "wifi-lan transport enabled");
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
        // LAN inbox: decrypt + write to clipboard with the same loop guards.
        let lan_task = async {
            loop {
                if let Some(env) = lan_rx.recv().await {
                    let _ = self.apply_lan_envelope(&*writer, &sess, &env).await;
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
