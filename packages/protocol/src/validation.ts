import { LIMITS, type ClipboardItem, type ContentType } from "./types.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

export function isBase64(s: unknown, maxBytes = LIMITS.MAX_ITEM_BYTES): boolean {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.length > Math.ceil(maxBytes * 4 / 3) + 8) return false;
  try {
    const buf = Buffer.from(s, "base64");
    if (buf.length === 0 || buf.length > maxBytes) return false;
    // round-trip check (allow padding variants)
    return buf.toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "");
  } catch {
    return false;
  }
}

export function validateItemUpload(body: unknown): { ok: true; value: UploadShape } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return err("body must be an object");
  const b = body as Record<string, unknown>;
  if (!isUuid(b.id)) return err("id must be UUIDv4");
  if (b.content_type !== "text/plain") return err("content_type must be 'text/plain' in v1");
  if (!isBase64(b.ciphertext)) return err("ciphertext must be base64 within size limit");
  if (!isBase64(b.nonce, 64)) return err("nonce must be base64 (<=64 bytes)");
  if (b.metadata !== undefined && (typeof b.metadata !== "object" || b.metadata === null))
    return err("metadata must be an object");
  if (b.expires_at !== undefined && b.expires_at !== null && isNaN(Date.parse(String(b.expires_at))))
    return err("expires_at must be ISO date or null");
  return {
    ok: true,
    value: {
      id: b.id as string,
      content_type: b.content_type as ContentType,
      ciphertext: b.ciphertext as string,
      nonce: b.nonce as string,
      metadata: (b.metadata ?? {}) as Record<string, unknown>,
      expires_at: (b.expires_at ?? null) as string | null,
    },
  };
}

export interface UploadShape {
  id: string;
  content_type: ContentType;
  ciphertext: string;
  nonce: string;
  metadata: Record<string, unknown>;
  expires_at: string | null;
}

function err(error: string) {
  return { ok: false as const, error };
}

/** Cursor pagination: opaque cursor = base64url of last item's (created_at,id). */
export function encodeCursor(created_at: string, id: string): string {
  return Buffer.from(JSON.stringify({ c: created_at, i: id })).toString("base64url");
}

export function decodeCursor(cursor: string | undefined): { created_at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const o = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (typeof o.c === "string" && typeof o.i === "string") return { created_at: o.c, id: o.i };
    return null;
  } catch {
    return null;
  }
}

/** Deterministic item ordering: (created_at, id). Used by clients + server + tests. */
export function compareItems(a: Pick<ClipboardItem, "created_at" | "id">, b: Pick<ClipboardItem, "created_at" | "id">): number {
  if (a.created_at < b.created_at) return -1;
  if (a.created_at > b.created_at) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Loop prevention: a device must never re-broadcast an item it already applied. */
export function shouldApplyRemoteItem(localDeviceId: string, item: Pick<ClipboardItem, "source_device_id" | "id">, seenIds: Set<string>): boolean {
  if (seenIds.has(item.id)) return false; // duplicate delivery
  void localDeviceId;
  return true;
}
