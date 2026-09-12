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

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_REV: Record<string, number> = {};
for (let i = 0; i < B64_ALPHABET.length; i++) B64_REV[B64_ALPHABET[i]] = i;

/**
 * STANDARD base64 encode. Hand-rolled (no global `btoa`): Hermes' `btoa` is
 * unreliable on some Android builds, and every real sync key needs correct
 * `=` padding. Output matches Rust `STANDARD.encode` and Node
 * `Buffer.toString("base64")` byte-for-byte.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_ALPHABET[(n >> 18) & 63] + B64_ALPHABET[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[n & 63] : "=";
  }
  return out;
}

/**
 * STANDARD base64 decode. Hand-rolled (no global `atob`): Hermes' `atob`
 * throws on `=` padding on some Android builds, which made EVERY valid
 * 32-byte sync key (always `...=`-padded) fail validation and produced the
 * endless "Sync key missing" popup. Whitespace is stripped so keys pasted
 * with terminal line-wraps still decode; anything else strict so keys stay
 * byte-compatible with `ucm key-show` / `ucm key-import` on Linux.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 4 !== 0) throw new Error("invalid base64 length");
  let pad = 0;
  if (clean.endsWith("==")) pad = 2;
  else if (clean.endsWith("=")) pad = 1;
  const body = pad > 0 ? clean.slice(0, -pad) : clean;
  if (!/^[A-Za-z0-9+/]+$/.test(body)) throw new Error("invalid base64 characters");
  const out = new Uint8Array((clean.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const quad = [clean[i], clean[i + 1], clean[i + 2], clean[i + 3]];
    const vals = quad.map((ch, j) => {
      if (ch === "=") {
        // Padding is only legal in the last quad, last 1-2 slots.
        if (i + 4 !== clean.length || j < 2 + (pad === 1 ? 1 : 0)) {
          throw new Error("misplaced base64 padding");
        }
        return 0;
      }
      const v = B64_REV[ch];
      if (v === undefined) throw new Error("invalid base64 characters");
      return v;
    });
    const n = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    out[o++] = (n >> 16) & 255;
    if (quad[2] !== "=") out[o++] = (n >> 8) & 255;
    if (quad[3] !== "=") out[o++] = n & 255;
  }
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

/**
 * Mint a fresh 32-byte E2E sync key (STANDARD base64, 44 chars).
 * Use for first-run onboarding when the user has no Linux key yet —
 * they then run `ucm key-import <key>` on Linux so both sides match.
 * Throws a descriptive error (instead of a bare TypeError) when the
 * device offers no secure random generator.
 */
export function generateSyncKeyB64(): string {
  const g = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (!g || typeof g.getRandomValues !== "function") {
    throw new Error("no secure random generator on this phone (crypto.getRandomValues is missing)");
  }
  return bytesToBase64(randomBytes(32));
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
