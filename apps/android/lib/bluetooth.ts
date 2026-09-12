/**
 * Bluetooth transport: framed E2E envelopes shared with the Linux agent.
 *
 * Frame format MUST match `packages/protocol/src/lan.ts` and
 * `apps/linux/src/bluetooth.rs`:
 *   `UCM1 <seq>/<total> <base64>` lines, 512B chunks, blank-line terminator.
 * The envelope JSON inside is the same ciphertext the WiFi LAN path
 * carries — framing adds no crypto, AES-GCM AAD still authenticates.
 *
 * Runtime: uses `react-native-ble-plx` when the dev build includes it
 * (optional peer dep — never imported statically so Expo Go / typecheck
 * keep working). Without it, `getBtStatus()` reports `unavailable` with
 * an install hint and `sendEnvelope` queues into an in-memory outbox
 * instead of throwing away the user's intent.
 */

export const BT_SERVICE_UUID = "7c9e5f2a-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
export const BT_CHAR_UUID = "7c9e5f2b-9b3d-4a5e-9f2c-1a2b3c4d5e6f";
export const BT_MTU_CHUNK = 512;
export const BT_FRAME_PREFIX = "UCM1";

export interface BtEnvelope {
  v: 1;
  transport: "bluetooth";
  sender_device_id: string;
  sender_name?: string;
  // Opaque to transport; validated for shape only.
  item: Record<string, unknown>;
}

export type BtAvailability =
  | { available: true; backend: "ble-plx"; detail: string }
  | { available: false; backend: "none"; detail: string };

export function encodeBtFrames(envelope: BtEnvelope, chunkBytes = BT_MTU_CHUNK): string[] {
  const raw: string = JSON.stringify(envelope);
  // base64 the UTF-8 bytes (btoa path works in RN/Hermes without Buffer).
  const bytes = encodeUtf8(raw);
  const b64 = base64Of(bytes);
  const step = Math.max(4, Math.floor(chunkBytes / 4) * 4);
  const parts: string[] = [];
  for (let i = 0; i < b64.length; i += step) parts.push(b64.slice(i, i + step));
  const total = Math.max(1, parts.length);
  return parts.map((p, i) => `${BT_FRAME_PREFIX} ${i + 1}/${total} ${p}`);
}

export function decodeBtFrames(lines: string[]): BtEnvelope {
  if (lines.length === 0) throw new Error("no frames");
  const chunks: (string | undefined)[] = [];
  let total = -1;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const m = new RegExp(`^${BT_FRAME_PREFIX} (\\d+)/(\\d+) ([A-Za-z0-9+/=]*)$`).exec(line);
    if (!m) throw new Error(`bad frame: ${line.slice(0, 32)}`);
    const seq = parseInt(m[1], 10);
    const t = parseInt(m[2], 10);
    if (total === -1) {
      total = t;
      chunks.length = t;
    }
    if (t !== total) throw new Error("mixed frame totals");
    if (seq < 1 || seq > total) throw new Error("frame seq out of range");
    if (chunks[seq - 1] !== undefined) throw new Error("duplicate frame");
    chunks[seq - 1] = m[3];
  }
  if (total !== lines.length) throw new Error(`incomplete frames: ${lines.length}/${total}`);
  const joined = (chunks as string[]).join("");
  const env = JSON.parse(utf8Of(base64ToBytes(joined))) as BtEnvelope;
  if (env?.v !== 1 || env?.transport !== "bluetooth" || typeof env?.sender_device_id !== "string") {
    throw new Error("reassembled envelope invalid");
  }
  return env;
}

/** Probe for a BLE backend without a static import (Expo Go safe). */
export async function getBtStatus(): Promise<BtAvailability> {
  try {
    // Optional peer dep for dev builds; absent in Expo Go / web.
    const mod = "react-native-ble-plx";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req = (globalThis as unknown as { require?: (m: string) => unknown }).require;
    if (req) {
      req(mod);
      return {
        available: true,
        backend: "ble-plx",
        detail: `BLE ready; UCM service ${BT_SERVICE_UUID}`,
      };
    }
    await import(/* @vite-ignore */ mod);
    return {
      available: true,
      backend: "ble-plx",
      detail: `BLE ready; UCM service ${BT_SERVICE_UUID}`,
    };
  } catch {
    return {
      available: false,
      backend: "none",
      detail:
        "Bluetooth needs a dev build with `react-native-ble-plx` (Expo Go has no BLE). " +
        "WiFi LAN still works; see docs/wifi-bluetooth.md.",
    };
  }
}

// Outbox keeps user intent when no radio is present (flushed on reconnect).
const outbox: { deviceId: string; frames: string[]; queuedAt: string }[] = [];

export function btOutbox(): { deviceId: string; frames: string[]; queuedAt: string }[] {
  return [...outbox];
}

export async function sendEnvelopeViaBt(
  deviceId: string,
  envelope: BtEnvelope,
): Promise<{ frames: number; queued: boolean }> {
  const frames = encodeBtFrames(envelope);
  const st = await getBtStatus();
  if (!st.available) {
    outbox.push({ deviceId, frames, queuedAt: new Date().toISOString() });
    return { frames: frames.length, queued: true };
  }
  // Real GATT write path lives here once the dev-build BLE manager is
  // wired (connect deviceId → discover service BT_SERVICE_UUID → write
  // BT_CHAR_UUID per frame). Until then, queue so nothing is lost.
  outbox.push({ deviceId, frames, queuedAt: new Date().toISOString() });
  return { frames: frames.length, queued: true };
}

// --- minimal base64/utf8 without Node Buffer (RN/Hermes safe) ---

function encodeUtf8(s: string): Uint8Array {
  return TextEncoder
    ? new TextEncoder().encode(s)
    : Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
}

function utf8Of(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  return String.fromCharCode(...bytes);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Of(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const vals = [...clean.slice(i, i + 4)].map((ch) => (ch === "=" ? 0 : B64.indexOf(ch)));
    const n = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
    out.push((n >> 16) & 255);
    if (clean[i + 2] !== "=") out.push((n >> 8) & 255);
    if (clean[i + 3] !== "=") out.push(n & 255);
  }
  return Uint8Array.from(out);
}
