/**
 * Unified transport policy: wifi-lan → bluetooth.
 *
 * Direct device-to-device sync only — no accounts, no phone-number
 * registration, no cloud relay. Mirrors `pickTransport` in
 * `@ucm/protocol` (lan.ts) and `pick_transport` in
 * `apps/linux/src/transport.rs`. Only capability flags and on/off
 * switches are inspected — never clipboard contents.
 */
import { healthCheck, listLanPeers, pushEnvelope, type LanPeer, type WifiEnvelope } from "./lan";
import { getBtStatus, sendEnvelopeViaBt, btOutbox, type BtEnvelope } from "./bluetooth";
import * as SecureStore from "expo-secure-store";

export type Transport = "wifi" | "bluetooth";

export interface TransportPolicy {
  wifiEnabled: boolean;
  bluetoothEnabled: boolean;
}

export const DEFAULT_POLICY: TransportPolicy = {
  wifiEnabled: true,
  bluetoothEnabled: true,
};

/** Policy toggles persisted by the Settings screen (both on unless disabled). */
export async function loadPolicy(): Promise<TransportPolicy> {
  const [w, b] = await Promise.all([
    SecureStore.getItemAsync("ucm.wifi"),
    SecureStore.getItemAsync("ucm.bt"),
  ]);
  return { wifiEnabled: w !== "0", bluetoothEnabled: b !== "0" };
}

export function pickTransport(
  capabilities: string[],
  hasWifiRoute: boolean,
  policy: TransportPolicy = DEFAULT_POLICY,
): Transport | null {
  const caps = new Set(capabilities);
  if (policy.wifiEnabled && hasWifiRoute && caps.has("wifi-lan")) return "wifi";
  if (policy.bluetoothEnabled && caps.has("bluetooth")) return "bluetooth";
  return null;
}

export interface TransportStatus {
  policy: TransportPolicy;
  wifiPeers: number;
  btAvailable: boolean;
  btDetail: string;
  btQueued: number;
}

export async function getTransportStatus(
  policy: TransportPolicy = DEFAULT_POLICY,
): Promise<TransportStatus> {
  const bt = await getBtStatus();
  return {
    policy,
    wifiPeers: listLanPeers().length,
    btAvailable: bt.available,
    btDetail: bt.detail,
    btQueued: btOutbox().length,
  };
}

export interface ClipboardPayload {
  id: string;
  content_type: "text/plain";
  ciphertext: string;
  nonce: string;
  metadata: Record<string, unknown>;
  owner_id: string;
  source_device_id: string;
  sender_name?: string;
  created_at: string;
  expires_at: string | null;
}

/**
 * Fan out one already-encrypted item over every enabled transport
 * (wifi → bluetooth). Best-effort per link; failures never throw —
 * the caller keeps the offline queue as the backstop (same contract
 * as the Linux engine).
 */
export async function fanOut(
  payload: ClipboardPayload,
  policy: TransportPolicy = DEFAULT_POLICY,
): Promise<{ wifi: number; bluetooth: number; errors: string[] }> {
  const errors: string[] = [];
  let wifi = 0;
  let bluetooth = 0;

  if (policy.wifiEnabled) {
    const peers: LanPeer[] = listLanPeers();
    const env: WifiEnvelope = {
      v: 1,
      transport: "wifi",
      sender_device_id: payload.source_device_id,
      sender_name: payload.sender_name,
      item: {
        id: payload.id,
        owner_id: payload.owner_id,
        source_device_id: payload.source_device_id,
        content_type: payload.content_type,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        metadata: payload.metadata,
        created_at: payload.created_at,
        expires_at: payload.expires_at,
        deleted_at: null,
      },
    };
    for (const p of peers) {
      try {
        if (await healthCheck(p)) {
          await pushEnvelope(p, env);
          wifi += 1;
        }
      } catch (e) {
        errors.push(`wifi ${p.host}: ${e}`);
      }
    }
  }

  if (policy.bluetoothEnabled) {
    const env: BtEnvelope = {
      v: 1,
      transport: "bluetooth",
      sender_device_id: payload.source_device_id,
      sender_name: payload.sender_name,
      item: {
        id: payload.id,
        owner_id: payload.owner_id,
        source_device_id: payload.source_device_id,
        content_type: payload.content_type,
        ciphertext: payload.ciphertext,
        nonce: payload.nonce,
        metadata: payload.metadata,
        created_at: payload.created_at,
        expires_at: payload.expires_at,
        deleted_at: null,
      },
    };
    try {
      // Broadcast to paired BT peers; without a connected device this
      // stages into the outbox (counted, never lost).
      const r = await sendEnvelopeViaBt("broadcast", env);
      bluetooth = r.queued ? 0 : 1;
    } catch (e) {
      errors.push(`bluetooth: ${e}`);
    }
  }

  return { wifi, bluetooth, errors };
}
