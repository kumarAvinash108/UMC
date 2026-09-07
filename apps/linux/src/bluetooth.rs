//! Bluetooth transport: framed E2E envelopes over RFCOMM / BLE GATT.
//!
//! Mirrors the framing in `packages/protocol/src/lan.ts`
//! (`UCM1 <seq>/<total> <base64>` lines, `BT_MTU_CHUNK = 512`).
//!
//! Architecture: this module owns the *framing + envelope validation* and a
//! stream-based transfer (`write_envelope` / `read_envelope`) that works over
//! ANY reliable byte stream — RFCOMM socket, BLE L2CAP CoC, or a TCP socket
//! in tests. The BlueZ adapter setup itself (advertise/scan/pair) is
//! intentionally behind [`BtAdapter`], whose default implementation probes
//! the real stack (`bluetoothctl`, `/sys/class/bluetooth`) and reports a
//! structured [`BtStatus`] instead of failing the daemon when no radio
//! exists (CI, VMs, containers). Swapping in the `bluer` crate later only
//! means implementing `BtAdapter` — framing stays untouched.

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tracing::{info, warn};

use crate::lan::{validate_envelope, LanEnvelope};

/// Must match `BT_SERVICE_UUID` in `@ucm/protocol` + Android `lib/bluetooth.ts`.
pub const SERVICE_UUID: &str = "7c9e5f2a-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
/// Must match `BT_CHAR_UUID` in `@ucm/protocol`.
pub const CHAR_UUID: &str = "7c9e5f2b-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
/// Must match `BT_MTU_CHUNK` (conservative for BLE writes).
pub const MTU_CHUNK: usize = 512;
pub const FRAME_PREFIX: &str = "UCM1";

#[derive(Debug, Clone)]
pub struct BtStatus {
    pub available: bool,
    pub powered: bool,
    pub detail: String,
}

/// Probe the host Bluetooth stack without taking exclusive ownership.
/// Returns `available=false` (with a human-readable `detail`) on headless
/// CI/VMs instead of erroring, so `ucm daemon` keeps running on WiFi/cloud.
pub fn availability() -> BtStatus {
    if !std::path::Path::new("/sys/class/bluetooth").exists() {
        // `bluetoothctl` may still exist via USB dongles that haven't
        // registered sysfs yet — check both before giving up.
        match std::process::Command::new("bluetoothctl").arg("--version").output() {
            Ok(o) if o.status.success() => {
                let v = String::from_utf8_lossy(&o.stdout).trim().to_string();
                return BtStatus { available: true, powered: false, detail: format!("radio sysfs missing, {v} present — dongle may be unplugged") };
            }
            _ => {
                return BtStatus {
                    available: false,
                    powered: false,
                    detail: "no /sys/class/bluetooth and no bluetoothctl — Bluetooth disabled or unavailable (WiFi/cloud still work)".into(),
                }
            }
        }
    }
    let powered = std::process::Command::new("bluetoothctl")
        .args(["show"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("Powered: yes"))
        .unwrap_or(false);
    BtStatus {
        available: true,
        powered,
        detail: if powered {
            format!("adapter ready; advertise service {SERVICE_UUID} via BlueZ (see `ucm bt-status`)")
        } else {
            "adapter present but not powered — run `bluetoothctl power on`".into()
        },
    }
}

/// Split envelope JSON into MTU-sized `UCM1 seq/total base64` frame lines.
pub fn encode_frames(env: &LanEnvelope) -> Result<Vec<String>> {
    let raw = serde_json::to_vec(env)?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, raw);
    let step = (MTU_CHUNK / 4 * 4).max(4);
    let mut parts = Vec::new();
    let mut i = 0;
    while i < b64.len() {
        let end = (i + step).min(b64.len());
        parts.push(b64[i..end].to_string());
        i = end;
    }
    if parts.is_empty() {
        parts.push(String::new());
    }
    let total = parts.len();
    Ok(parts
        .into_iter()
        .enumerate()
        .map(|(k, p)| format!("{FRAME_PREFIX} {}/{total} {p}", k + 1))
        .collect())
}

/// Reassemble + validate frames (order-independent, duplicates rejected).
pub fn decode_frames(lines: &[String]) -> Result<LanEnvelope> {
    if lines.is_empty() {
        anyhow::bail!("no frames");
    }
    let mut chunks: Vec<Option<String>> = Vec::new();
    let mut total: Option<usize> = None;
    for line in lines {
        let rest = line.strip_prefix(&format!("{FRAME_PREFIX} ")).context("bad frame prefix")?;
        let (seq_total, payload) = rest.split_once(' ').context("bad frame shape")?;
        let (seq_s, total_s) = seq_total.split_once('/').context("bad frame seq")?;
        let seq: usize = seq_s.parse().context("bad seq")?;
        let t: usize = total_s.parse().context("bad total")?;
        match total {
            None => {
                total = Some(t);
                chunks.resize(t, None);
            }
            Some(prev) if prev != t => anyhow::bail!("mixed frame totals"),
            _ => {}
        }
        if seq < 1 || seq > t {
            anyhow::bail!("frame seq out of range");
        }
        if chunks[seq - 1].is_some() {
            anyhow::bail!("duplicate frame");
        }
        chunks[seq - 1] = Some(payload.to_string());
    }
    let total = total.unwrap_or(0);
    if total == 0 {
        anyhow::bail!("no frames");
    }
    if chunks.iter().any(|c| c.is_none()) {
        anyhow::bail!("incomplete frames");
    }
    let joined: String = chunks.into_iter().flatten().collect();
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    let raw = B64.decode(&joined).context("frame base64")?;
    let env: LanEnvelope = serde_json::from_slice(&raw).context("envelope json")?;
    validate_envelope(&env)?;
    if env.transport != "bluetooth" {
        anyhow::bail!("expected bluetooth envelope");
    }
    Ok(env)
}

/// Write one envelope as newline-delimited frames on any byte stream
/// (RFCOMM socket, L2CAP CoC, test TCP). Ends with a blank line sentinel.
pub async fn write_envelope<W>(writer: &mut W, env: &LanEnvelope) -> Result<usize>
where
    W: AsyncWrite + Unpin,
{
    let frames = encode_frames(env)?;
    let n = frames.len();
    for f in &frames {
        writer.write_all(f.as_bytes()).await?;
        writer.write_all(b"\n").await?;
    }
    writer.write_all(b"\n").await?; // end-of-envelope sentinel
    writer.flush().await?;
    Ok(n)
}

/// Read frames until the blank-line sentinel, then reassemble + validate.
/// `max_frames` bounds memory against a hostile peer (default 512 ≈ 256 KiB).
pub async fn read_envelope<R>(reader: &mut BufReader<R>, max_frames: usize) -> Result<LanEnvelope>
where
    R: AsyncRead + Unpin,
{
    let mut lines: Vec<String> = Vec::new();
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.context("bt read")?;
        if n == 0 {
            if lines.is_empty() {
                anyhow::bail!("peer closed connection");
            }
            break;
        }
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            break; // sentinel
        }
        lines.push(trimmed);
        if lines.len() > max_frames {
            anyhow::bail!("envelope too many frames");
        }
    }
    decode_frames(&lines)
}

/// Send over an established stream and log at info level (no plaintext).
pub async fn send_over_stream<S>(stream: &mut S, env: &LanEnvelope) -> Result<usize>
where
    S: AsyncWrite + Unpin,
{
    let n = write_envelope(stream, env).await?;
    info!(frames = n, id = %env.item.id, "bt envelope sent");
    Ok(n)
}

/// Adapter hook for real BlueZ work (advertise/scan/connect). The default
/// `NoopAdapter` keeps the daemon healthy where no radio exists; a future
/// `bluer`-backed impl slots in here without touching framing or sync.
#[async_trait::async_trait]
pub trait BtAdapter: Send + Sync {
    fn status(&self) -> BtStatus;
    async fn advertise(&self) -> Result<()>;
    async fn scan(&self, secs: u64) -> Result<Vec<DiscoveredBtPeer>>;
}

#[derive(Debug, Clone)]
pub struct DiscoveredBtPeer {
    pub address: String,
    pub name: Option<String>,
    pub service_found: bool,
}

pub struct NoopAdapter;

#[async_trait::async_trait]
impl BtAdapter for NoopAdapter {
    fn status(&self) -> BtStatus {
        availability()
    }
    async fn advertise(&self) -> Result<()> {
        let st = availability();
        if !st.available {
            warn!(detail = %st.detail, "bt advertise skipped");
            return Ok(());
        }
        info!("bt advertise: register GATT service {SERVICE_UUID} via bluetoothctl/bluer (see docs/wifi-bluetooth.md)");
        Ok(())
    }
    async fn scan(&self, _secs: u64) -> Result<Vec<DiscoveredBtPeer>> {
        let st = availability();
        if !st.available {
            warn!(detail = %st.detail, "bt scan skipped");
            return Ok(vec![]);
        }
        info!("bt scan: use `bluetoothctl scan on` then `ucm bt-send --addr <MAC>` (native GATT client lands with the bluer backend)");
        Ok(vec![])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::LanItem;

    fn env() -> LanEnvelope {
        LanEnvelope {
            v: 1,
            transport: "bluetooth".into(),
            sender_device_id: "d1".into(),
            sender_name: Some("ubuntu".into()),
            item: LanItem {
                id: "123e4567-e89b-12d3-a456-426614174000".into(),
                owner_id: "u1".into(),
                source_device_id: "d1".into(),
                content_type: "text/plain".into(),
                ciphertext: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"hello-bt"),
                nonce: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"123456789012"),
                metadata: serde_json::json!({}),
                created_at: "2024-01-01T00:00:00.000Z".into(),
                expires_at: None,
                deleted_at: None,
            },
        }
    }

    #[test]
    fn frames_roundtrip_small_and_large() {
        let e = env();
        let f = encode_frames(&e).unwrap();
        assert_eq!(decode_frames(&f).unwrap().item.id, e.item.id);
        let mut big = e.clone();
        big.item.ciphertext = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, vec![b'x'; 5000]);
        let frames = encode_frames(&big).unwrap();
        assert!(frames.len() > 1);
        let mut rev = frames.clone();
        rev.reverse();
        assert_eq!(decode_frames(&rev).unwrap().item.id, big.item.id);
    }

    #[test]
    fn frames_reject_corrupt() {
        let e = env();
        let f = encode_frames(&e).unwrap();
        assert!(decode_frames(&f[..f.len().saturating_sub(1)]).is_err() || f.len() == 1);
        assert!(decode_frames(&["UCM1 1/1 !!!".to_string()]).is_err());
        // wrong transport tag must fail even if framing is fine
        let mut wifi = e.clone();
        wifi.transport = "wifi".into();
        let fw = encode_frames(&wifi).unwrap();
        assert!(decode_frames(&fw).is_err());
    }

    #[tokio::test]
    async fn stream_roundtrip_over_tcp() {
        let e = env();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let mut r = BufReader::new(sock);
            read_envelope(&mut r, 512).await.unwrap()
        });
        let mut cli = tokio::net::TcpStream::connect(addr).await.unwrap();
        send_over_stream(&mut cli, &e).await.unwrap();
        let got = srv.await.unwrap();
        assert_eq!(got.item.id, e.item.id);
    }

    #[test]
    fn availability_never_panics() {
        let st = availability();
        assert!(!st.detail.is_empty());
    }
}
