//! Device keys in the Linux secret service (keyring); fallback to 0600 file.
//!
//! The keyring path is async (secret-service v4 + tokio runtime); every
//! caller runs inside the `#[tokio::main]` runtime. Any keyring failure
//! (headless CI, locked collection, no D-Bus) falls back to the 0600 file
//! so the daemon keeps working — the file remains usable as source of truth.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::collections::HashMap;

const SERVICE: &str = "ucm-clipboard";
const ACCOUNT: &str = "device-key";

/// Load or create the 32-byte device encryption key.
pub async fn load_or_create_key(data_dir: &str) -> anyhow::Result<[u8; 32]> {
    if let Ok(key) = from_secret_service().await {
        return Ok(key);
    }
    let path = format!("{data_dir}/device.key");
    if let Ok(raw) = std::fs::read(&path) {
        if raw.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&raw);
            return Ok(k);
        }
    }
    let mut k = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut k);
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&path, k)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    // Best-effort mirror into keyring (ignore failure: file remains source of truth).
    let _ = to_secret_service(&k).await;
    Ok(k)
}

fn attrs() -> HashMap<&'static str, &'static str> {
    HashMap::from([("service", SERVICE), ("account", ACCOUNT)])
}

/// Base64 of the device key, for `ucm key-show` (copy into the phone's
/// Settings → Sync key). The key NEVER leaves this machine except through
/// this explicit user action — it is never uploaded to the sync service.
pub async fn show_key_b64(data_dir: &str) -> anyhow::Result<String> {
    let k = load_or_create_key(data_dir).await?;
    Ok(B64.encode(k))
}

/// Short fingerprint for visual verification. MUST match the fingerprint
/// shown in the Android app (`keyFingerprint` in `lib/crypto.ts`).
pub fn fingerprint_b64(key_b64: &str) -> String {
    let t = key_b64.trim();
    if t.len() < 12 {
        return "invalid".into();
    }
    format!("{}…{}", &t[..8], &t[t.len() - 4..])
}

/// Replace the device key (to adopt a key shared from another device).
/// Old local history becomes undecryptable — that is expected, since the
/// old key is gone; new copies will sync with the shared key.
pub async fn import_key_b64(data_dir: &str, key_b64: &str) -> anyhow::Result<()> {
    let raw = B64.decode(key_b64.trim())?;
    if raw.len() != 32 {
        anyhow::bail!("key must decode to exactly 32 bytes");
    }
    std::fs::create_dir_all(data_dir)?;
    let path = format!("{data_dir}/device.key");
    std::fs::write(&path, &raw)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&raw);
    let _ = to_secret_service(&k).await;
    Ok(())
}

async fn from_secret_service() -> anyhow::Result<[u8; 32]> {
    let ss = secret_service::SecretService::connect(secret_service::EncryptionType::Dh).await?;
    let col = ss.get_default_collection().await?;
    if col.is_locked().await? {
        col.unlock().await?;
    }
    let items = col.search_items(attrs()).await?;
    let item = items.into_iter().next().ok_or_else(|| anyhow::anyhow!("no key"))?;
    let secret = item.get_secret().await?;
    let raw = B64.decode(&secret)?;
    if raw.len() != 32 {
        anyhow::bail!("bad key length");
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&raw);
    Ok(k)
}

async fn to_secret_service(key: &[u8; 32]) -> anyhow::Result<()> {
    let ss = secret_service::SecretService::connect(secret_service::EncryptionType::Dh).await?;
    let col = ss.get_default_collection().await?;
    if col.is_locked().await? {
        col.unlock().await?;
    }
    col.create_item("UCM device key", attrs(), B64.encode(key).as_bytes(), true, "text/plain").await?;
    Ok(())
}
