import * as SecureStore from "expo-secure-store";
import { randomId } from "./crypto";
import { getDb } from "./store";

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
/**
 * Where a secret ended up living. `secure` = hardware-backed keystore,
 * `fallback` = app-private SQLite (used only when the keystore throws —
 * e.g. broken KeyStore on some devices/ROMs). The fallback keeps sync
 * working; it is still sandboxed to this app, just without hardware
 * backing. Callers surface this so the user knows.
 */
export type SecretHome = "secure" | "fallback";

async function fallbackSet(name: string, value: string): Promise<void> {
  const db = await getDb();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  await db.runAsync(
    `INSERT INTO secrets(name,value) VALUES(?,?)
     ON CONFLICT(name) DO UPDATE SET value=excluded.value`,
    [name, value],
  );
}

async function fallbackGet(name: string): Promise<string | null> {
  const db = await getDb();
  await db.execAsync(
    `CREATE TABLE IF NOT EXISTS secrets(name TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM secrets WHERE name=?`,
    [name],
  );
  return row?.value ?? null;
}

async function secureSet(name: string, value: string): Promise<SecretHome> {
  try {
    await SecureStore.setItemAsync(name, value);
    return "secure";
  } catch {
    await fallbackSet(name, value);
    return "fallback";
  }
}

async function secureGet(name: string): Promise<{ value: string | null; home: SecretHome | null }> {
  try {
    const v = await SecureStore.getItemAsync(name);
    if (v !== null) return { value: v, home: "secure" };
  } catch {
    // Keystore unreadable — try the app-private fallback below.
  }
  try {
    const v = await fallbackGet(name);
    return { value: v, home: v === null ? null : "fallback" };
  } catch {
    return { value: null, home: null };
  }
}

export async function getSyncKeyB64(): Promise<string | null> {
  return (await secureGet(K.syncKey)).value;
}

/** True when the saved sync key lives in the SQLite fallback (keystore broken). */
export async function syncKeyInFallback(): Promise<boolean> {
  return (await secureGet(K.syncKey)).home === "fallback";
}

export async function setSyncKeyB64(keyB64: string): Promise<SecretHome> {
  return secureSet(K.syncKey, keyB64.trim());
}

/** Stable device id for WiFi/Bluetooth sync (never leaves the phone except inside envelopes). */
export async function getOrCreateLocalDeviceId(): Promise<string> {
  const existing = await secureGet(K.localDeviceId);
  if (existing.value) return existing.value;
  const id = randomId();
  await secureSet(K.localDeviceId, id);
  return id;
}

export async function resetAll() {
  await Promise.all(
    Object.values(K).map((k) => SecureStore.deleteItemAsync(k).catch(() => {})),
  );
  try {
    const db = await getDb();
    await db.runAsync(`DELETE FROM secrets WHERE name IN (?,?)`, [K.syncKey, K.localDeviceId]);
  } catch {
    // Best-effort: SecureStore side is already wiped.
  }
}
