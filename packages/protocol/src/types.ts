/** @ucm/protocol — versioned shared types. PROTOCOL_VERSION must bump on breaking change. */
export const PROTOCOL_VERSION = 1;

export type Platform = "linux" | "android" | "unknown";
export type ContentType = "text/plain";

export interface Device {
  id: string;
  user_id: string;
  name: string;
  platform: Platform;
  /** base64-encoded X25519/Ed25519 public key (opaque to server) */
  public_key: string;
  last_seen_at: string;
  revoked_at: string | null;
}

export interface ClipboardItem {
  id: string; // client-generated UUIDv4, conflict-safe
  owner_id: string;
  source_device_id: string;
  content_type: ContentType;
  /** base64 ciphertext (E2E encrypted, opaque to server) */
  ciphertext: string;
  /** base64 nonce/IV */
  nonce: string;
  metadata: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
  deleted_at: string | null;
}

/** AAD binding: clients MUST bind these fields into AEAD additional data. */
export interface ItemAAD {
  v: number;
  id: string;
  owner_id: string;
  source_device_id: string;
  content_type: ContentType;
  created_at: string;
}

export interface PairingRequest {
  code: string; // 6-digit short code, hashed server-side
  requester_device_id: string;
  requester_public_key: string;
  requester_name: string;
  platform: Platform;
  expires_at: string;
  consumed_at: string | null;
}

export type SyncEvent =
  | { type: "item.created"; item: ClipboardItem }
  | { type: "item.deleted"; id: string; deleted_at: string }
  | { type: "device.revoked"; device_id: string };

export interface Paginated<T> {
  items: T[];
  next_cursor: string | null;
}

export const LIMITS = {
  MAX_ITEM_BYTES: 64 * 1024, // 64 KiB ciphertext in v1
  MAX_HISTORY_PER_USER: 1000,
  MAX_PAGE_SIZE: 100,
  SHORT_CODE_BYTES: 3, // 6-digit code
} as const;

export const EXPIRY_PRESETS = ["1h", "1d", "7d", "never"] as const;
export type ExpiryPreset = (typeof EXPIRY_PRESETS)[number];

export function expiryToDate(preset: ExpiryPreset, from = new Date()): string | null {
  if (preset === "never") return null;
  const ms = preset === "1h" ? 3600_000 : preset === "1d" ? 86_400_000 : 7 * 86_400_000;
  return new Date(from.getTime() + ms).toISOString();
}
