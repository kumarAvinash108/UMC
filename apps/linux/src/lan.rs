//! WiFi LAN transport: UDP beacons for discovery + HTTP push of E2E envelopes.
//!
//! Mirrors `packages/protocol/src/lan.ts`. The envelope carries the SAME
//! `ClipboardItem` ciphertext the cloud API stores — this module never
//! decrypts, it only routes opaque bytes between peers on the same WiFi.
//!
//! Discovery needs no mDNS daemon: agents broadcast [`Beacon`] JSON over UDP
//! to `255.255.255.255:<DISCOVERY_PORT>` and listen on the same port.
//! Sync itself is `POST http://<peer>:<tcp_port>/lan/v1/items` with the
//! [`LanEnvelope`] as body. Only tokio + reqwest + serde are used so the
//! agent keeps building without new system dependencies.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UdpSocket},
    sync::{mpsc, Mutex},
};
use tracing::{info, warn};

/// Must match `LAN_SERVICE_TYPE` in `@ucm/protocol`.
pub const SERVICE_TYPE: &str = "_ucm-clipboard._tcp";
pub const HTTP_PATH: &str = "/lan/v1/items";
pub const HEALTH_PATH: &str = "/lan/v1/health";
/// Must match `LAN_DISCOVERY_UDP_PORT`.
pub const DISCOVERY_PORT: u16 = 41234;
/// Must match `LAN_DEFAULT_TCP_PORT`.
pub const DEFAULT_TCP_PORT: u16 = 41235;
pub const BEACON_INTERVAL: Duration = Duration::from_millis(5_000);
pub const PEER_EXPIRY: Duration = Duration::from_millis(15_000);
const MAX_ITEM_BYTES: usize = 64 * 1024;

/// Presence beacon broadcast on UDP. Keep field names identical to TS.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Beacon {
    pub v: u32,
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub tcp_port: u16,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

/// Ciphertext item as carried inside a LAN envelope (subset of ClipboardItem).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanItem {
    pub id: String,
    pub owner_id: String,
    pub source_device_id: String,
    pub content_type: String,
    pub ciphertext: String,
    pub nonce: String,
    #[serde(default)]
    pub metadata: serde_json::Value,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub deleted_at: Option<String>,
}

/// Opaque E2E envelope routed over WiFi. Never contains plaintext.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanEnvelope {
    pub v: u32,
    pub transport: String,
    pub sender_device_id: String,
    pub sender_name: Option<String>,
    pub item: LanItem,
}

impl LanEnvelope {
    pub fn new_wifi(sender_device_id: &str, sender_name: &str, item: LanItem) -> Self {
        Self {
            v: 1,
            transport: "wifi".into(),
            sender_device_id: sender_device_id.into(),
            sender_name: Some(sender_name.into()),
            item,
        }
    }
}

/// Shape validation: version, transport tag, UUID-ish id, size cap.
/// Crypto integrity itself is enforced later by AES-GCM AAD on decrypt.
pub fn validate_envelope(env: &LanEnvelope) -> Result<()> {
    if env.v != 1 {
        anyhow::bail!("envelope v must be 1");
    }
    if env.transport != "wifi" && env.transport != "bluetooth" {
        anyhow::bail!("transport must be wifi|bluetooth");
    }
    if env.sender_device_id.is_empty() || env.item.id.is_empty() {
        anyhow::bail!("sender_device_id + item.id required");
    }
    if env.item.content_type != "text/plain" {
        anyhow::bail!("content_type must be text/plain in v1");
    }
    if base64_len(&env.item.ciphertext)? > MAX_ITEM_BYTES {
        anyhow::bail!("ciphertext too large");
    }
    Ok(())
}

fn base64_len(b64: &str) -> Result<usize> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    Ok(B64.decode(b64).map(|v| v.len()).unwrap_or(usize::MAX))
}

pub fn validate_beacon(b: &Beacon) -> Result<()> {
    if b.v != 1 {
        anyhow::bail!("beacon v must be 1");
    }
    if b.device_id.is_empty() || b.name.is_empty() {
        anyhow::bail!("beacon device_id + name required");
    }
    if b.platform != "linux" && b.platform != "android" {
        anyhow::bail!("beacon platform must be linux|android");
    }
    if b.tcp_port == 0 {
        anyhow::bail!("beacon tcp_port required");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Peer registry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PeerInfo {
    pub device_id: String,
    pub name: String,
    pub platform: String,
    pub host: String,
    pub tcp_port: u16,
    pub capabilities: Vec<String>,
    pub fingerprint: Option<String>,
    pub last_seen: std::time::Instant,
}

pub type PeerRegistry = Arc<Mutex<HashMap<String, PeerInfo>>>;

pub fn new_registry() -> PeerRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn peer_list(reg: &PeerRegistry) -> Vec<PeerInfo> {
    reg.lock().await.values().cloned().collect()
}

pub fn push_url(peer: &PeerInfo) -> String {
    format!("http://{}:{}{}", peer.host, peer.tcp_port, HTTP_PATH)
}

// ---------------------------------------------------------------------------
// Discovery: UDP broadcast beacons + listener
// ---------------------------------------------------------------------------

pub fn local_beacon(device_id: &str, name: &str, tcp_port: u16, capabilities: Vec<String>) -> Beacon {
    Beacon {
        v: 1,
        device_id: device_id.into(),
        name: name.into(),
        platform: "linux".into(),
        tcp_port,
        capabilities,
        fingerprint: None,
    }
}

/// Broadcast our beacon every [`BEACON_INTERVAL`] so phones/desktops on the
/// same WiFi can find us without any cloud account.
pub async fn announce_loop(beacon: Beacon, discovery_port: u16) -> Result<()> {
    let sock = UdpSocket::bind("0.0.0.0:0").await?;
    sock.set_broadcast(true)?;
    let dest = format!("255.255.255.255:{discovery_port}");
    let body = serde_json::to_vec(&beacon)?;
    info!(port = discovery_port, "lan announce started");
    loop {
        if let Err(e) = sock.send_to(&body, &dest).await {
            warn!(error = %e, "lan beacon send failed");
        }
        tokio::time::sleep(BEACON_INTERVAL).await;
    }
}

/// Listen for peer beacons; ignores our own `device_id`. Peers older than
/// [`PEER_EXPIRY`] are evicted lazily on each received datagram.
pub async fn discover_loop(registry: PeerRegistry, own_device_id: String, discovery_port: u16) -> Result<()> {
    let sock = UdpSocket::bind(format!("0.0.0.0:{discovery_port}")).await?;
    info!(port = discovery_port, "lan discover listening");
    let mut buf = vec![0u8; 2048];
    loop {
        let (n, addr) = match sock.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "lan discover recv failed");
                continue;
            }
        };
        // Expire stale peers on every datagram (cheap, runs at beacon rate).
        {
            let mut reg = registry.lock().await;
            reg.retain(|_, p| p.last_seen.elapsed() < PEER_EXPIRY);
        }
        let beacon: Beacon = match serde_json::from_slice(&buf[..n]) {
            Ok(b) => b,
            Err(_) => continue, // ignore non-UCM traffic on the port
        };
        if validate_beacon(&beacon).is_err() || beacon.device_id == own_device_id {
            continue;
        }
        let mut reg = registry.lock().await;
        reg.insert(
            beacon.device_id.clone(),
            PeerInfo {
                device_id: beacon.device_id.clone(),
                name: beacon.name.clone(),
                platform: beacon.platform.clone(),
                host: addr.ip().to_string(),
                tcp_port: beacon.tcp_port,
                capabilities: beacon.capabilities.clone(),
                fingerprint: beacon.fingerprint.clone(),
                last_seen: std::time::Instant::now(),
            },
        );
    }
}

// ---------------------------------------------------------------------------
// Sync: minimal HTTP listener (tokio only) + push client
// ---------------------------------------------------------------------------

/// Serve the LAN API off the local replica database (`db_path`):
/// - `GET /lan/v1/health` — presence check for pollers.
/// - `POST /lan/v1/items` — accept an envelope; valid ones are forwarded to
///   `tx` for the sync engine to decrypt + apply + store.
/// - `GET /lan/v1/items?since=<ts>&since_id=<id>&limit=<n>` — servable slice
///   of the replica (ciphertext only) so phones can poll without any cloud.
/// The listener itself never sees plaintext.
pub async fn serve(tcp_port: u16, tx: mpsc::Sender<LanEnvelope>, db_path: String) -> Result<()> {
    let listener = TcpListener::bind(format!("0.0.0.0:{tcp_port}")).await?;
    info!(port = tcp_port, "lan http listening");
    loop {
        let (stream, addr) = listener.accept().await?;
        let tx = tx.clone();
        let db_path = db_path.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(stream, &tx, &db_path).await {
                warn!(peer = %addr, error = %e, "lan conn failed");
            }
        });
    }
}

/// Minimal percent-decoder for query values (enough for ISO timestamps).
fn pct_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.as_bytes().iter();
    while let Some(&b) = it.next() {
        if b == b'%' {
            let hi = it.next().copied().unwrap_or(b'0');
            let lo = it.next().copied().unwrap_or(b'0');
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push((hex(hi) << 4 | hex(lo)) as char);
        } else if b == b'+' {
            out.push(' ');
        } else {
            out.push(b as char);
        }
    }
    out
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(pct_decode(v));
            }
        }
    }
    None
}

/// Build servable envelopes from replica rows (ciphertext untouched).
fn envelopes_for(rows: &[crate::db::LocalItem]) -> Vec<LanEnvelope> {
    rows.iter()
        .map(|r| LanEnvelope {
            v: 1,
            transport: "wifi".into(),
            sender_device_id: r.source_device_id.clone(),
            sender_name: None,
            item: LanItem {
                id: r.id.clone(),
                owner_id: r.owner_id.clone(),
                source_device_id: r.source_device_id.clone(),
                content_type: "text/plain".into(),
                ciphertext: r.ciphertext.clone(),
                nonce: r.nonce.clone(),
                metadata: serde_json::json!({}),
                created_at: r.created_at.clone(),
                expires_at: None,
                deleted_at: None,
            },
        })
        .collect()
}

async fn handle_conn(mut stream: tokio::net::TcpStream, tx: &mpsc::Sender<LanEnvelope>, db_path: &str) -> Result<()> {
    let mut buf = vec![0u8; 128 * 1024];
    let n = stream.read(&mut buf).await.context("read request")?;
    if n == 0 {
        return Ok(());
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut content_length = 0usize;
    let mut header_end = 0usize;
    if let Some(idx) = head.find("\r\n\r\n") {
        header_end = idx + 4;
        for line in head[..idx].lines().skip(1) {
            if let Some(v) = line.strip_prefix("Content-Length:").or_else(|| line.strip_prefix("content-length:")) {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    } else if let Some(idx) = head.find("\n\n") {
        header_end = idx + 2;
    }
    // Body may already be fully in `buf` for small envelopes (the common case).
    let mut body = buf[header_end..n].to_vec();
    while body.len() < content_length {
        let m = stream.read(&mut buf).await?;
        if m == 0 {
            break;
        }
        body.extend_from_slice(&buf[..m]);
    }

    let (status, payload) = if request_line.starts_with("GET ") && request_line.contains(HEALTH_PATH) {
        ("200 OK", serde_json::json!({"ok": true, "service": SERVICE_TYPE}).to_string())
    } else if request_line.starts_with("GET ") && request_line.contains(HTTP_PATH) {
        // Replica poll: /lan/v1/items?since=<ts>&since_id=<id>&limit=<n>
        let query = request_line.split_whitespace().nth(1).unwrap_or_default()
            .split_once('?').map(|(_, q)| q).unwrap_or_default().to_string();
        let since = query_param(&query, "since").unwrap_or_default();
        let since_id = query_param(&query, "since_id").unwrap_or_default();
        let limit: usize = query_param(&query, "limit").and_then(|v| v.parse().ok()).unwrap_or(50);
        let cursor = if since.is_empty() { None } else { Some((since.as_str(), since_id.as_str())) };
        match crate::db::Db::open(db_path).map(|db| db.list_since(cursor, limit)) {
            Ok(Ok(rows)) => ("200 OK", serde_json::json!({"items": envelopes_for(&rows)}).to_string()),
            Ok(Err(e)) | Err(e) => ("500 Internal Server Error", format!(r#"{{"error":"db: {e}"}}"#)),
        }
    } else if request_line.starts_with("POST ") && request_line.contains(HTTP_PATH) {
        match serde_json::from_slice::<LanEnvelope>(&body) {
            Ok(env) if validate_envelope(&env).is_ok() => {
                let id = env.item.id.clone();
                if tx.send(env).await.is_err() {
                    ("500 Internal Server Error", r#"{"error":"engine gone"}"#.into())
                } else {
                    ("200 OK", format!(r#"{{"ok":true,"id":"{id}"}}"#))
                }
            }
            Ok(_) => ("400 Bad Request", r#"{"error":"invalid envelope"}"#.into()),
            Err(e) => ("400 Bad Request", format!(r#"{{"error":"bad json: {e}"}}"#)),
        }
    } else {
        ("404 Not Found", r#"{"error":"unknown lan path"}"#.into())
    };
    let resp = format!(
        "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream.write_all(resp.as_bytes()).await?;
    Ok(())
}

/// Replica row from a validated inbound envelope (ciphertext untouched).
/// Used by the engine and `lan-serve` so every Linux node serves the full
/// mesh history to LAN pollers (phones).
pub fn to_local_item(env: &LanEnvelope, uploaded: bool) -> crate::db::LocalItem {
    crate::db::LocalItem {
        id: env.item.id.clone(),
        ciphertext: env.item.ciphertext.clone(),
        nonce: env.item.nonce.clone(),
        created_at: env.item.created_at.clone(),
        owner_id: env.item.owner_id.clone(),
        source_device_id: env.item.source_device_id.clone(),
        uploaded,
        pinned: false,
    }
}

/// Push one envelope to a single peer (fire-and-forget from the engine).
pub async fn push_to_peer(peer: &PeerInfo, env: &LanEnvelope) -> Result<()> {
    let client = reqwest::Client::new();
    client
        .post(push_url(peer))
        .json(env)
        .timeout(Duration::from_secs(5))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

/// Broadcast to all live WiFi peers; returns (delivered, attempted).
/// Delivery errors are logged, never fatal — a sleeping peer just misses
/// this push and catches up on its next `GET /lan/v1/items` poll, and every
/// Linux node keeps a full replica so any of them can serve it.
pub async fn broadcast(registry: &PeerRegistry, env: &LanEnvelope) -> (usize, usize) {
    let peers: Vec<PeerInfo> = {
        let mut reg = registry.lock().await;
        reg.retain(|_, p| p.last_seen.elapsed() < PEER_EXPIRY);
        reg.values()
            .filter(|p| p.capabilities.iter().any(|c| c == "wifi-lan"))
            .cloned()
            .collect()
    };
    let mut ok = 0;
    for peer in &peers {
        match push_to_peer(peer, env).await {
            Ok(()) => ok += 1,
            Err(e) => warn!(peer = %peer.device_id, error = %e, "lan push failed"),
        }
    }
    (ok, peers.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> LanEnvelope {
        LanEnvelope {
            v: 1,
            transport: "wifi".into(),
            sender_device_id: "d1".into(),
            sender_name: Some("ubuntu".into()),
            item: LanItem {
                id: "123e4567-e89b-12d3-a456-426614174000".into(),
                owner_id: "u1".into(),
                source_device_id: "d1".into(),
                content_type: "text/plain".into(),
                ciphertext: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"secret",
                ),
                nonce: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    b"123456789012",
                ),
                metadata: serde_json::json!({}),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                expires_at: None,
                deleted_at: None,
            },
        }
    }

    #[test]
    fn envelope_validation() {
        assert!(validate_envelope(&envelope()).is_ok());
        let mut bad = envelope();
        bad.transport = "nfc".into();
        assert!(validate_envelope(&bad).is_err());
        let mut bad2 = envelope();
        bad2.item.content_type = "image/png".into();
        assert!(validate_envelope(&bad2).is_err());
    }

    #[test]
    fn beacon_roundtrip() {
        let b = local_beacon("d1", "ubuntu", 41235, vec!["wifi-lan".into()]);
        assert!(validate_beacon(&b).is_ok());
        let raw = serde_json::to_vec(&b).unwrap();
        let back: Beacon = serde_json::from_slice(&raw).unwrap();
        assert_eq!(back.device_id, "d1");
    }

    #[tokio::test]
    async fn serve_push_and_poll_roundtrip() {
        let (tx, mut rx) = mpsc::channel::<LanEnvelope>(8);
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("history.db").to_string_lossy().to_string();
        // Seed the replica with one servable row.
        {
            let db = crate::db::Db::open(&db_path).unwrap();
            db.insert(&crate::db::LocalItem {
                id: "123e4567-e89b-12d3-a456-426614174000".into(),
                ciphertext: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"secret"),
                nonce: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"123456789012"),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                owner_id: "u1".into(), source_device_id: "d1".into(),
                uploaded: true, pinned: false,
            }).unwrap();
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let srv = tokio::spawn(serve(port, tx, db_path));
        tokio::time::sleep(Duration::from_millis(100)).await;
        let env = envelope();
        let peer = PeerInfo {
            device_id: "d1".into(),
            name: "t".into(),
            platform: "linux".into(),
            host: "127.0.0.1".into(),
            tcp_port: port,
            capabilities: vec!["wifi-lan".into()],
            fingerprint: None,
            last_seen: std::time::Instant::now(),
        };
        // POST path: envelope forwarded to the engine channel.
        push_to_peer(&peer, &env).await.unwrap();
        let got = tokio::time::timeout(Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
        assert_eq!(got.item.id, env.item.id);
        // GET path: replica poll returns the seeded row as an envelope.
        let client = reqwest::Client::new();
        let page: serde_json::Value = client
            .get(format!("http://127.0.0.1:{port}{HTTP_PATH}?limit=50"))
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["item"]["ciphertext"], env.item.ciphertext);
        // Cursor past it yields nothing.
        let page2: serde_json::Value = client
            .get(format!("http://127.0.0.1:{port}{HTTP_PATH}?since=2024-01-01T00%3A00%3A00.000Z&since_id=123e4567-e89b-12d3-a456-426614174000"))
            .send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
        assert!(page2["items"].as_array().unwrap().is_empty());
        srv.abort();
    }
}
