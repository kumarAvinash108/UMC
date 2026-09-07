//! AES-256-GCM E2E crypto. Mirrors packages/protocol (same AAD layout, v=1).
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use serde::Serialize;

#[derive(Serialize)]
struct Aad<'a> {
    v: u32,
    id: &'a str,
    owner_id: &'a str,
    source_device_id: &'a str,
    content_type: &'a str,
    created_at: &'a str,
}

pub fn encrypt(key: &[u8; 32], plaintext: &str, id: &str, owner: &str, device: &str, created_at: &str)
    -> anyhow::Result<(String, String)>
{
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let aad = serde_json::to_vec(&Aad { v: 1, id, owner_id: owner, source_device_id: device, content_type: "text/plain", created_at })?;
    let ct = cipher.encrypt(Nonce::from_slice(&nonce_bytes),
        aes_gcm::aead::Payload { msg: plaintext.as_bytes(), aad: &aad })
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok((B64.encode(ct), B64.encode(nonce_bytes)))
}

pub fn decrypt(key: &[u8; 32], ciphertext_b64: &str, nonce_b64: &str, id: &str, owner: &str, device: &str, created_at: &str)
    -> anyhow::Result<String>
{
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let ct = B64.decode(ciphertext_b64)?;
    let nonce = B64.decode(nonce_b64)?;
    let aad = serde_json::to_vec(&Aad { v: 1, id, owner_id: owner, source_device_id: device, content_type: "text/plain", created_at })?;
    let pt = cipher.decrypt(Nonce::from_slice(&nonce),
        aes_gcm::aead::Payload { msg: &ct, aad: &aad })
        .map_err(|_| anyhow::anyhow!("decrypt failed (tampered or wrong key)"))?;
    Ok(String::from_utf8(pt)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let mut key = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut key);
        let (ct, nonce) = encrypt(&key, "hello 🎉\nline2", "id-1", "owner-1", "dev-1", "2024-05-01T12:00:00.000Z").unwrap();
        assert_eq!(
            decrypt(&key, &ct, &nonce, "id-1", "owner-1", "dev-1", "2024-05-01T12:00:00.000Z").unwrap(),
            "hello 🎉\nline2"
        );
        // swapped metadata must fail auth
        assert!(decrypt(&key, &ct, &nonce, "id-1", "owner-1", "evil", "2024-05-01T12:00:00.000Z").is_err());
    }

    /// Fixed vector produced by the Android JS path (@noble/ciphers, AES-GCM,
    /// same AAD layout). Guards cross-platform byte-compat: if this fails,
    /// Android and Linux can no longer read each other's clipboard.
    /// key = bytes 0..32, nonce = bytes 0..12 (see docs/wifi-bluetooth.md).
    #[test]
    fn android_interop_vector() {
        let key: [u8; 32] = core::array::from_fn(|i| i as u8);
        let ct = "MmG7O6yLtn7/Luerx4wbGeykp8Rv9da94mM2U+qPuEU9XAW54a7+";
        let nonce = B64.encode([0u8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        let pt = decrypt(
            &key,
            ct,
            &nonce,
            "123e4567-e89b-12d3-a456-426614174000",
            "user-1",
            "dev-1",
            "2024-05-01T12:00:00.000Z",
        )
        .expect("android-produced vector must decrypt");
        assert_eq!(pt, "ucm interop vector 🎉");
    }
}
