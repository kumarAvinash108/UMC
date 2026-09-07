/**
 * E2E crypto for the Android app (AES-256-GCM via @noble/ciphers).
 *
 * Byte-compat contract (MUST match or cross-device decrypt fails):
 * - AAD JSON: {"v":1,"id","owner_id","source_device_id","content_type","created_at"}
 *   — same bytes as Rust `apps/linux/src/crypto.rs` (serde field order) and
 *   `packages/protocol/src/crypto.ts` (`buildAAD`). Field ORDER is load-bearing.
 * - Ciphertext layout: raw_ct || 16-byte tag, STANDARD base64 (same as the
 *   Node `crypto` impl and the Rust `aes-gcm` crate).
 * - Nonce: 12 random bytes, STANDARD base64.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { utf8ToBytes, bytesToUtf8 } from "@noble/ciphers/utils.js";

export interface ItemAAD {
  id: string;
  owner_id: string;
  source_device_id: string;
  content_type: "text/plain";
  created_at: string;
}

/** Exact AAD bytes. Constructed with an explicit literal so key order is fixed. */
export function buildAADBytes(aad: ItemAAD): Uint8Array {
  const ordered = {
    v: 1,
    id: aad.id,
    owner_id: aad.owner_id,
    source_device_id: aad.source_device_id,
    content_type: aad.content_type,
    created_at: aad.created_at,
  };
  return utf8ToBytes(JSON.stringify(ordered));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isValidKeyB64(s: string | null | undefined): s is string {
  if (typeof s !== "string") return false;
  try {
    return base64ToBytes(s).length === 32;
  } catch {
    return false;
  }
}

/** Short fingerprint for visual verify. MUST match Rust `fingerprint_b64`. */
export function keyFingerprint(keyB64: string): string {
  const t = keyB64.trim();
  if (t.length < 12) return "invalid";
  return `${t.slice(0, 8)}…${t.slice(-4)}`;
}

/**
 * Key-derived owner id for serverless LAN mode. Deterministic in the shared
 * sync key, so every device holding the same key lands in the same owner
 * namespace with zero coordination. MUST match Rust `lan_owner_id`:
 * `local-` + STANDARD-base64(key) with `=` stripped, `+`→`-`, `/`→`_`.
 */
export function lanOwnerId(keyB64: string): string {
  const clean = keyB64
    .trim()
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `local-${clean}`;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Random UUIDv4 for client-generated item ids (conflict-safe). */
export function randomId(): string {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function encryptText(params: { keyB64: string; plaintext: string; aad: ItemAAD }): {
  ciphertextB64: string;
  nonceB64: string;
} {
  const key = base64ToBytes(params.keyB64);
  if (key.length !== 32) throw new Error("sync key must decode to 32 bytes");
  const nonce = randomBytes(12);
  const out = gcm(key, nonce, buildAADBytes(params.aad)).encrypt(utf8ToBytes(params.plaintext));
  return { ciphertextB64: bytesToBase64(out), nonceB64: bytesToBase64(nonce) };
}

export function decryptText(params: {
  keyB64: string;
  ciphertextB64: string;
  nonceB64: string;
  aad: ItemAAD;
}): string {
  const key = base64ToBytes(params.keyB64);
  if (key.length !== 32) throw new Error("sync key must decode to 32 bytes");
  try {
    const pt = gcm(key, base64ToBytes(params.nonceB64), buildAADBytes(params.aad)).decrypt(
      base64ToBytes(params.ciphertextB64),
    );
    return bytesToUtf8(pt);
  } catch {
    throw new Error("decrypt failed (wrong sync key or tampered item)");
  }
}
