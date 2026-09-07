import * as SecureStore from "expo-secure-store";
import { randomId } from "./crypto";

/**
 * Device identity + session. Private key material lives in Android
 * Keystore-backed SecureStore; server only ever sees the public key.
 */
const K = {
  userId: "ucm.user_id",
  token: "ucm.token",
  deviceId: "ucm.device_id",
  key: "ucm.key_b64",
  /** Shared E2E clipboard key (same bytes as `ucm key-show` on Linux). */
  syncKey: "ucm.sync_key_b64",
  /** Stable LAN-only device id (used when the cloud never issued one). */
  localDeviceId: "ucm.local_device_id",
};

function b64(bytes: Uint8Array): string {
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s);
}

export async function loadIdentity() {
  const [user_id, token, device_id, key_b64] = await Promise.all([
    SecureStore.getItemAsync(K.userId),
    SecureStore.getItemAsync(K.token),
    SecureStore.getItemAsync(K.deviceId),
    SecureStore.getItemAsync(K.key),
  ]);
  return { user_id, token, device_id, key_b64 };
}

export async function saveIdentity(i: { user_id: string; token: string; device_id: string }) {
  await Promise.all([
    SecureStore.setItemAsync(K.userId, i.user_id),
    SecureStore.setItemAsync(K.token, i.token),
    SecureStore.setItemAsync(K.deviceId, i.device_id),
  ]);
}

/** 32-byte device key, generated once. NOTE: production should use AES-GCM via
 *  a native module; this v1 scaffold stores the key and does crypto in JS. */
export async function loadOrCreateKeyB64(): Promise<string> {
  const existing = await SecureStore.getItemAsync(K.key);
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b = b64(bytes);
  await SecureStore.setItemAsync(K.key, b);
  return b;
}

/**
 * Shared E2E clipboard key. This is what actually encrypts clipboard items
 * and MUST be identical on every device (Linux: `ucm key-show` → paste in
 * Settings → Sync key). The per-device `ucm.key_b64` above is only a local
 * placeholder and is never used for clipboard crypto.
 */
export async function getSyncKeyB64(): Promise<string | null> {
  return SecureStore.getItemAsync(K.syncKey);
}

export async function setSyncKeyB64(keyB64: string): Promise<void> {
  await SecureStore.setItemAsync(K.syncKey, keyB64.trim());
}

/** Stable device id for serverless LAN mode (never leaves the phone except inside envelopes). */
export async function getOrCreateLocalDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(K.localDeviceId);
  if (existing) return existing;
  const id = randomId();
  await SecureStore.setItemAsync(K.localDeviceId, id);
  return id;
}

export async function resetAll() {
  await Promise.all(Object.values(K).map((k) => SecureStore.deleteItemAsync(k)));
}
