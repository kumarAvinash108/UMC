/**
 * @ucm/protocol — WiFi LAN + Bluetooth peer-to-peer transport (v1).
 *
 * Design constraints (see UNIVERSAL_CLIPBOARD_PLAN.md + docs/protocol.md):
 * - The sync server NEVER sees plaintext. LAN/BT envelopes carry the SAME
 *   E2E ciphertext (`ClipboardItem.ciphertext`/`nonce`) — transport never
 *   decrypts, only routes opaque bytes.
 * - WiFi LAN = UDP beacons for discovery + plain HTTP POST of the envelope
 *   to a peer's `/lan/v1/items`. No new crypto, no pairing server needed
 *   on-LAN (pairing trust still comes from the account flow).
 * - Bluetooth = the same envelope JSON, split into small frames so it fits
 *   RFCOMM packets / BLE GATT writes (MTU-friendly). Framing is transport
 *   only — integrity still comes from AES-GCM AAD, not from framing.
 */

import type { ClipboardItem, P2PCapability, Platform } from "./types.js";
import { validateItemUpload } from "./validation.js";

/** mDNS-style service label (also used as UDP beacon marker). */
export const LAN_SERVICE_TYPE = "_ucm-clipboard._tcp";
/** Path served by each Linux agent's LAN listener. */
export const LAN_HTTP_PATH = "/lan/v1/items";
export const LAN_HEALTH_PATH = "/lan/v1/health";
/** UDP port for LAN discovery beacons (broadcast). */
export const LAN_DISCOVERY_UDP_PORT = 41234;
/** Default TCP port for the LAN HTTP listener. */
export const LAN_DEFAULT_TCP_PORT = 41235;
/** How often to broadcast presence on WiFi (ms). */
export const LAN_BEACON_INTERVAL_MS = 5_000;
/** Drop peers not seen for this long (ms). */
export const LAN_PEER_EXPIRY_MS = 15_000;

/**
 * Fixed 128-bit service UUID identifying UCM clipboard sync on Bluetooth.
 * Linux (BlueZ RFCOMM/GATT) and Android (BLE) MUST use this value so the
 * two sides find each other without any out-of-band config.
 */
export const BT_SERVICE_UUID = "7c9e5f2a-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
/** GATT characteristic used for framed envelope writes. */
export const BT_CHAR_UUID = "7c9e5f2b-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
/** Max payload bytes per Bluetooth frame (conservative for BLE MTU). */
export const BT_MTU_CHUNK = 512;
/** Frame line prefix: `UCM1 <seq>/<total> <base64-chunk>`. */
export const BT_FRAME_PREFIX = "UCM1";

export type P2PTransport = "wifi" | "bluetooth" | "cloud";
export type { P2PCapability };

/** Opaque E2E envelope routed over WiFi LAN or Bluetooth. */
export interface LanEnvelope {
  v: 1;
  transport: "wifi" | "bluetooth";
  sender_device_id: string;
  sender_name?: string;
  /** Full ClipboardItem as stored by the cloud API (ciphertext only). */
  item: ClipboardItem;
}

/** Presence beacon broadcast on UDP (same WiFi) or advertised on BT. */
export interface PeerBeacon {
  v: 1;
  device_id: string;
  name: string;
  platform: Platform;
  /** TCP port of the LAN HTTP listener (WiFi peers). */
  tcp_port: number;
  capabilities: P2PCapability[];
  /** Truncated public-key fingerprint for display while pairing. */
  fingerprint?: string;
}

/** Known peer aggregated from beacons / manual entry / cloud device list. */
export interface PeerInfo {
  device_id: string;
  name: string;
  platform: Platform;
  host?: string;
  tcp_port?: number;
  capabilities: P2PCapability[];
  fingerprint?: string;
  last_seen_at: string;
}

export function validateBeacon(
  b: unknown,
): { ok: true; value: PeerBeacon } | { ok: false; error: string } {
  if (typeof b !== "object" || b === null) return err("beacon must be an object");
  const o = b as Record<string, unknown>;
  if (o.v !== 1) return err("beacon v must be 1");
  if (typeof o.device_id !== "string" || !o.device_id) return err("beacon device_id required");
  if (typeof o.name !== "string" || !o.name) return err("beacon name required");
  if (o.platform !== "linux" && o.platform !== "android")
    return err("beacon platform must be linux|android");
  if (typeof o.tcp_port !== "number" || o.tcp_port < 1 || o.tcp_port > 65535)
    return err("beacon tcp_port must be 1..65535");
  if (!Array.isArray(o.capabilities)) return err("beacon capabilities must be an array");
  for (const c of o.capabilities as unknown[]) {
    if (c !== "wifi-lan" && c !== "bluetooth") return err("unknown capability");
  }
  return {
    ok: true,
    value: {
      v: 1,
      device_id: o.device_id as string,
      name: o.name as string,
      platform: o.platform as Platform,
      tcp_port: o.tcp_port as number,
      capabilities: o.capabilities as P2PCapability[],
      fingerprint: typeof o.fingerprint === "string" ? (o.fingerprint as string) : undefined,
    },
  };
}

export function validateLanEnvelope(
  e: unknown,
): { ok: true; value: LanEnvelope } | { ok: false; error: string } {
  if (typeof e !== "object" || e === null) return err("envelope must be an object");
  const o = e as Record<string, unknown>;
  if (o.v !== 1) return err("envelope v must be 1");
  if (o.transport !== "wifi" && o.transport !== "bluetooth")
    return err("transport must be wifi|bluetooth");
  if (typeof o.sender_device_id !== "string" || !o.sender_device_id)
    return err("sender_device_id required");
  if (typeof o.item !== "object" || o.item === null) return err("item required");
  const it = o.item as Record<string, unknown>;
  // Reuse the cloud upload shape validation (ciphertext size, UUID, nonce…).
  const v = validateItemUpload({
    id: it.id,
    content_type: it.content_type,
    ciphertext: it.ciphertext,
    nonce: it.nonce,
    metadata: it.metadata ?? {},
    expires_at: it.expires_at ?? null,
  });
  if (!v.ok) return err(`item invalid: ${v.error}`);
  for (const f of ["owner_id", "source_device_id", "created_at"] as const) {
    if (typeof it[f] !== "string" || !it[f]) return err(`item.${f} required`);
  }
  const value: LanEnvelope = {
    v: 1,
    transport: o.transport as "wifi" | "bluetooth",
    sender_device_id: o.sender_device_id as string,
    item: o.item as ClipboardItem,
  };
  if (typeof o.sender_name === "string") value.sender_name = o.sender_name;
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Bluetooth framing: split envelope JSON into MTU-sized newline frames.
// `UCM1 <seq>/<total> <base64>` — base64 keeps frames 7-bit safe over
// RFCOMM line readers and BLE characteristic writes alike.
// ---------------------------------------------------------------------------

export function encodeBtFrames(envelope: LanEnvelope, chunkBytes = BT_MTU_CHUNK): string[] {
  const raw = Buffer.from(JSON.stringify(envelope), "utf8");
  const b64 = raw.toString("base64");
  // base64 expands ~4/3; chunk the *decoded-bytes-equivalent* by slicing b64
  // in multiples of 4 so every frame stays valid base64 on its own.
  const step = Math.max(4, Math.floor(chunkBytes / 4) * 4);
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += step) parts.push(b64.slice(i, i + step));
  const total = Math.max(1, parts.length);
  return parts.map((p, i) => `${BT_FRAME_PREFIX} ${i + 1}/${total} ${p}`);
}

export function decodeBtFrames(lines: string[]): LanEnvelope {
  if (lines.length === 0) throw new Error("no frames");
  const chunks = new Array<string>(lines.length);
  let total = -1;
  for (const line of lines) {
    const m = new RegExp(`^${BT_FRAME_PREFIX} (\\d+)/(\\d+) ([A-Za-z0-9+/=]*)$`).exec(line.trim());
    if (!m) throw new Error(`bad frame: ${line.slice(0, 32)}`);
    const seq = parseInt(m[1], 10);
    const t = parseInt(m[2], 10);
    if (total === -1) total = t;
    if (t !== total) throw new Error("mixed frame totals");
    if (seq < 1 || seq > total) throw new Error("frame seq out of range");
    if (chunks[seq - 1] !== undefined) throw new Error("duplicate frame");
    chunks[seq - 1] = m[3];
  }
  if (total !== lines.length) throw new Error(`incomplete frames: ${lines.length}/${total}`);
  if (chunks.some((c) => c === undefined)) throw new Error("missing frames");
  const env = JSON.parse(Buffer.from(chunks.join(""), "base64").toString("utf8")) as unknown;
  const v = validateLanEnvelope(env);
  if (!v.ok) throw new Error(`reassembled envelope invalid: ${v.error}`);
  return v.value;
}

// ---------------------------------------------------------------------------
// Transport selection: prefer free/fast local links, fall back to cloud.
// ---------------------------------------------------------------------------

export interface TransportPolicy {
  wifiEnabled: boolean;
  bluetoothEnabled: boolean;
  cloudEnabled: boolean;
}

export function pickTransport(peer: PeerInfo, policy: TransportPolicy): P2PTransport | null {
  const caps = new Set(peer.capabilities);
  if (policy.wifiEnabled && caps.has("wifi-lan") && peer.host && peer.tcp_port) return "wifi";
  if (policy.bluetoothEnabled && caps.has("bluetooth")) return "bluetooth";
  if (policy.cloudEnabled) return "cloud";
  return null;
}

/** Merge a beacon into a peer map (dedupe by device_id, refresh last_seen). */
export function upsertPeerFromBeacon(
  peers: Map<string, PeerInfo>,
  beacon: PeerBeacon,
  host: string,
): PeerInfo {
  const now = new Date().toISOString();
  const prev = peers.get(beacon.device_id);
  const next: PeerInfo = {
    device_id: beacon.device_id,
    name: beacon.name,
    platform: beacon.platform,
    host,
    tcp_port: beacon.tcp_port,
    capabilities: beacon.capabilities,
    fingerprint: beacon.fingerprint ?? prev?.fingerprint,
    last_seen_at: now,
  };
  peers.set(beacon.device_id, next);
  return next;
}

/** Drop peers older than `LAN_PEER_EXPIRY_MS`. Returns evicted ids. */
export function expirePeers(peers: Map<string, PeerInfo>, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const [id, p] of peers) {
    if (nowMs - Date.parse(p.last_seen_at) > LAN_PEER_EXPIRY_MS) {
      peers.delete(id);
      out.push(id);
    }
  }
  return out;
}

export function lanHealthUrl(host: string, port: number): string {
  return `http://${host}:${port}${LAN_HEALTH_PATH}`;
}

export function lanPushUrl(host: string, port: number): string {
  return `http://${host}:${port}${LAN_HTTP_PATH}`;
}

function err(error: string) {
  return { ok: false as const, error };
}
