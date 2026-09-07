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
