import * as SecureStore from "expo-secure-store";

/**
 * Device identity + session. Private key material lives in Android
 * Keystore-backed SecureStore; server only ever sees the public key.
 */
const K = { userId: "ucm.user_id", token: "ucm.token", deviceId: "ucm.device_id", key: "ucm.key_b64" };

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

export async function resetAll() {
  await Promise.all(Object.values(K).map((k) => SecureStore.deleteItemAsync(k)));
}
