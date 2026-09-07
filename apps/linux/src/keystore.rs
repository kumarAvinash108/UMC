//! Device keys in the Linux secret service (keyring); fallback to 0600 file.
use base64::{engine::general_purpose::STANDARD as B64, Engine};

const SERVICE: &str = "ucm-clipboard";
const ACCOUNT: &str = "device-key";

/// Load or create the 32-byte device encryption key.
pub fn load_or_create_key(data_dir: &str) -> anyhow::Result<[u8; 32]> {
    if let Ok(key) = from_secret_service() {
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
    let _ = to_secret_service(&k);
    Ok(k)
}

fn from_secret_service() -> anyhow::Result<[u8; 32]> {
    let ss = secret_service::SecretService::connect(secret_service::EncryptionType::Dh)?;
    let col = ss.get_default_collection()?;
    if col.is_locked()? { col.unlock()?; }
    let items = col.search_items(vec![("service", SERVICE), ("account", ACCOUNT)])?;
    let item = items.into_iter().next().ok_or_else(|| anyhow::anyhow!("no key"))?;
    let secret = item.get_secret()?;
    let raw = B64.decode(&secret)?;
    if raw.len() != 32 { anyhow::bail!("bad key length"); }
    let mut k = [0u8; 32];
    k.copy_from_slice(&raw);
    Ok(k)
}

fn to_secret_service(key: &[u8; 32]) -> anyhow::Result<()> {
    let ss = secret_service::SecretService::connect(secret_service::EncryptionType::Dh)?;
    let col = ss.get_default_collection()?;
    if col.is_locked()? { col.unlock()?; }
    col.create_item("UCM device key", vec![("service", SERVICE), ("account", ACCOUNT)],
        B64.encode(key).as_bytes(), true, "text/plain")?;
    Ok(())
}
