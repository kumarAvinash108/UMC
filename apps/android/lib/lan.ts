/**
 * WiFi LAN transport: direct HTTP push to a Linux agent on the same network.
 *
 * Values MUST stay in sync with `@ucm/protocol` (lan.ts) and
 * `apps/linux/src/lan.rs`:
 * - discovery UDP 41234, default TCP 41235
 * - POST http://<host>:<port>/lan/v1/items with the E2E envelope
 *
 * This module never sees plaintext: callers pass already-encrypted
 * ciphertext/nonce straight through. Discovery here is intentionally
 * simple (manual host entry + health checks); a production build swaps
 * `discoverViaNsd` for an `expo-network` / NSD native module without
 * changing the envelope path.
 */

export const LAN_DISCOVERY_UDP_PORT = 41234;
export const LAN_DEFAULT_TCP_PORT = 41235;
export const LAN_HTTP_PATH = "/lan/v1/items";
export const LAN_HEALTH_PATH = "/lan/v1/health";

export type P2PCapability = "wifi-lan" | "bluetooth";

export interface LanPeer {
  device_id: string;
  name: string;
  platform: string;
  host: string;
  tcp_port: number;
  capabilities: P2PCapability[];
  last_seen_at: string;
}

export interface WifiEnvelopeItem {
  id: string;
  owner_id: string;
  source_device_id: string;
  content_type: "text/plain";
  ciphertext: string;
  nonce: string;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  deleted_at: string | null;
}

export interface WifiEnvelope {
  v: 1;
  transport: "wifi";
  sender_device_id: string;
  sender_name?: string;
  item: WifiEnvelopeItem;
}

const peers = new Map<string, LanPeer>();

export function listLanPeers(): LanPeer[] {
  return [...peers.values()].sort((a, b) => (a.last_seen_at < b.last_seen_at ? 1 : -1));
}

export function addManualPeer(
  host: string,
  tcp_port = LAN_DEFAULT_TCP_PORT,
  name = "linux-pc",
): LanPeer {
  const id = `manual:${host}:${tcp_port}`;
  const p: LanPeer = {
    device_id: id,
    name,
    platform: "linux",
    host,
    tcp_port,
    capabilities: ["wifi-lan"],
    last_seen_at: new Date().toISOString(),
  };
  peers.set(id, p);
  return p;
}

export function removeLanPeer(device_id: string) {
  peers.delete(device_id);
}

export function noteDiscoveredPeer(p: LanPeer) {
  peers.set(p.device_id, { ...p, last_seen_at: new Date().toISOString() });
}

export function lanPushUrl(host: string, port: number): string {
  return `http://${host}:${port}${LAN_HTTP_PATH}`;
}

export function lanHealthUrl(host: string, port: number): string {
  return `http://${host}:${port}${LAN_HEALTH_PATH}`;
}

/** Check a peer answers the LAN health endpoint (5s timeout). */
export async function healthCheck(peer: LanPeer): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    const res = await fetch(lanHealthUrl(peer.host, peer.tcp_port), { signal: ctl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Push an opaque E2E envelope to one peer. Throws with a hint on failure. */
export async function pushEnvelope(peer: LanPeer, envelope: WifiEnvelope): Promise<string> {
  let res: Response;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    res = await fetch(lanPushUrl(peer.host, peer.tcp_port), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: ctl.signal,
    });
    clearTimeout(t);
  } catch (e) {
    throw new Error(
      `Cannot reach ${peer.host}:${peer.tcp_port}. Same Wi-Fi? Is \`ucm daemon\`/` +
        `lan-serve running, and is ${peer.host} your PC's LAN IP (not localhost)? (${e})`,
    );
  }
  if (!res.ok) throw new Error(`LAN push -> ${res.status}`);
  const body = (await res.json()) as { id?: string };
  return body.id ?? envelope.item.id;
}

export function buildWifiEnvelope(args: {
  sender_device_id: string;
  sender_name?: string;
  item: WifiEnvelopeItem;
}): WifiEnvelope {
  return {
    v: 1,
    transport: "wifi",
    sender_device_id: args.sender_device_id,
    sender_name: args.sender_name,
    item: args.item,
  };
}
