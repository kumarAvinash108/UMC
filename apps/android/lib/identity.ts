import * as SecureStore from "expo-secure-store";
import { randomId } from "./crypto";

/**
 * Device identity for direct WiFi/Bluetooth sync. Key material lives in
 * Android Keystore-backed SecureStore. No accounts, no sessions, no
 * registration — the shared sync key + stable device id are everything.
 */
const K = {
  /** Shared E2E clipboard key (same bytes as `ucm key-show` on Linux). */
  syncKey: "ucm.sync_key_b64",
  /** Stable device id (goes inside envelopes, never leaves the mesh otherwise). */
  localDeviceId: "ucm.local_device_id",
};

/**
 * Shared E2E clipboard key. This is what actually encrypts clipboard items
 * and MUST be identical on every device (Linux: `ucm key-show` → paste here
 * on first run, or generate here and `ucm key-import` it on Linux).
 */
export async function getSyncKeyB64(): Promise<string | null> {
  return SecureStore.getItemAsync(K.syncKey);
}

export async function setSyncKeyB64(keyB64: string): Promise<void> {
  await SecureStore.setItemAsync(K.syncKey, keyB64.trim());
}

/** Stable device id for WiFi/Bluetooth sync (never leaves the phone except inside envelopes). */
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
