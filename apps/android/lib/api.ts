import Constants from "expo-constants";

/**
 * Resolve the sync-server URL.
 * 1. EXPO_PUBLIC_SYNC_URL (apps/android/.env or shell env when starting Metro)
 * 2. Dev-machine LAN IP derived from the Metro host Expo Go loaded us from
 *    (Constants.expoConfig.hostUri looks like "192.168.1.5:8081").
 *    A physical phone MUST use this — its own `localhost` is itself.
 * 3. localhost (Android emulator / same-machine only).
 */
function resolveBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_SYNC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:3000`;
  }
  return "http://localhost:3000";
}

/** API client: talks only ciphertext to the sync service. */
export const SYNC_BASE = resolveBase();
const BASE = SYNC_BASE;

async function req(path: string, token: string | null, init: RequestInit = {}) {
  let res: Response;
  try {
    res = await fetch(`${BASE}/v1${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch (e) {
    throw new Error(
      `Cannot reach sync server at ${BASE}${path}. Is the service running, is the phone on the same Wi-Fi, and is EXPO_PUBLIC_SYNC_URL your PC's LAN IP? (${e})`
    );
  }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`);
  return res.json();
}

export const api = {
  createSession: (user_id?: string): Promise<{ user_id: string; token: string }> =>
    req("/auth/session", null, { method: "POST", body: JSON.stringify({ user_id }) }),
  registerDevice: (token: string, name: string, platform: "android" | "linux", public_key: string, capabilities: string[] = ["wifi-lan", "bluetooth"]) =>
    req("/devices", token, { method: "POST", body: JSON.stringify({ name, platform, public_key, capabilities }) }),
  listDevices: (token: string) => req("/devices", token),
  revokeDevice: (token: string, id: string) => req(`/devices/${id}/revoke`, token, { method: "POST" }),
  requestPairing: (token: string, body: object) => req("/pairing/request", token, { method: "POST", body: JSON.stringify(body) }),
  confirmPairing: (token: string, code: string) =>
    req("/pairing/confirm", token, { method: "POST", body: JSON.stringify({ code }) }),
  uploadItem: (token: string, body: object) => req("/items", token, { method: "POST", body: JSON.stringify(body) }),
  listItems: (token: string, cursor?: string, limit = 50) =>
    req(`/items?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, token),
  deleteItem: (token: string, id: string) => req(`/items/${id}`, token, { method: "DELETE" }),
  ackItem: (token: string, id: string) => req(`/items/${id}/ack`, token, { method: "POST" }),
};

export function wsUrl(token: string) {
  return `${BASE.replace(/^http/, "ws")}/v1/sync?token=${token}`;
}
