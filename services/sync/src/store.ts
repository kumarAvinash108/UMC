import { randomUUID } from "node:crypto";
import type { ClipboardItem, Device, Platform, SyncEvent } from "@ucm/protocol";
import { compareItems, decodeCursor, encodeCursor } from "@ucm/protocol";
import { createHash, randomInt } from "node:crypto";

export interface Session {
  token: string;
  user_id: string;
  device_id: string | null;
  created_at: string;
}

export interface PairingEntry {
  code_hash: string;
  requester_device_id: string;
  requester_public_key: string;
  requester_name: string;
  platform: Platform;
  user_id: string; // approver's account (pairing is per-user)
  expires_at: string;
  consumed_at: string | null;
  code_hint: string; // last 2 digits for support, never full code
}

/** Storage interface — MemoryStore is default; PostgresStore implements same API. */
export interface Store {
  createUser(): { id: string };
  getUser(id: string): { id: string; created_at: string } | undefined;
  createSession(user_id: string): Session;
  getSession(token: string): Session | undefined;
  bindSessionDevice(token: string, device_id: string): void;
  createDevice(user_id: string, name: string, platform: Platform, public_key: string): Device;
  listDevices(user_id: string): Device[];
  revokeDevice(user_id: string, device_id: string): Device | undefined;
  isRevoked(user_id: string, device_id: string): boolean;
  upsertItem(item: ClipboardItem): { created: boolean; item: ClipboardItem };
  listItems(user_id: string, cursor: string | undefined, limit: number): { items: ClipboardItem[]; next_cursor: string | null };
  deleteItem(user_id: string, id: string): ClipboardItem | undefined;
  ackItem(user_id: string, device_id: string, id: string): boolean;
  createPairing(user_id: string, req: { requester_public_key: string; requester_name: string; platform: Platform }): { entry: PairingEntry; code: string };
  confirmPairing(user_id: string, code: string): PairingEntry | undefined;
  sweepExpired(): number;
  counts(): { users: number; devices: number; items: number };
}

export class MemoryStore implements Store {
  users = new Map<string, { id: string; created_at: string }>();
  sessions = new Map<string, Session>();
  devices = new Map<string, Device>(); // by device id
  items = new Map<string, ClipboardItem>(); // by item id (scoped per user via owner_id)
  acks = new Map<string, Set<string>>(); // item_id -> device_ids
  pairings = new Map<string, PairingEntry>(); // code_hash -> entry
  maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
  }

  createUser() {
    const id = randomUUID();
    this.users.set(id, { id, created_at: new Date().toISOString() });
    return { id };
  }
  getUser(id: string) {
    return this.users.get(id);
  }
  createSession(user_id: string): Session {
    const token = "ucm_" + randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const s: Session = { token, user_id, device_id: null, created_at: new Date().toISOString() };
    this.sessions.set(token, s);
    return s;
  }
  getSession(token: string) {
    return this.sessions.get(token);
  }
  bindSessionDevice(token: string, device_id: string) {
    const s = this.sessions.get(token);
    if (s) s.device_id = device_id;
  }
  createDevice(user_id: string, name: string, platform: Platform, public_key: string): Device {
    const now = new Date().toISOString();
    const d: Device = { id: randomUUID(), user_id, name, platform, public_key, last_seen_at: now, revoked_at: null };
    this.devices.set(d.id, d);
    return d;
  }
  listDevices(user_id: string) {
    return [...this.devices.values()].filter((d) => d.user_id === user_id);
  }
  revokeDevice(user_id: string, device_id: string) {
    const d = this.devices.get(device_id);
    if (!d || d.user_id !== user_id) return undefined;
    d.revoked_at = new Date().toISOString();
    return d;
  }
  isRevoked(user_id: string, device_id: string) {
    const d = this.devices.get(device_id);
    return !!d && d.user_id === user_id && d.revoked_at !== null;
  }

  upsertItem(item: ClipboardItem) {
    const existing = this.items.get(item.id);
    // Conflict-safe IDs: same id => idempotent, first write wins (prevents loops/dupes)
    if (existing && existing.owner_id === item.owner_id) return { created: false, item: existing };
    this.items.set(item.id, item);
    this.enforceRetention(item.owner_id);
    return { created: true, item };
  }

  listItems(user_id: string, cursor: string | undefined, limit: number) {
    const now = Date.now();
    let all = [...this.items.values()].filter(
      (i) => i.owner_id === user_id && !i.deleted_at && (!i.expires_at || Date.parse(i.expires_at) > now)
    );
    all.sort(compareItems);
    const decoded = decodeCursor(cursor);
    if (decoded) {
      all = all.filter(
        (i) => i.created_at > decoded.created_at || (i.created_at === decoded.created_at && i.id > decoded.id)
      );
    }
    const page = all.slice(0, limit);
    const next_cursor =
      all.length > page.length && page.length > 0
        ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id)
        : null;
    return { items: page, next_cursor };
  }

  deleteItem(user_id: string, id: string) {
    const it = this.items.get(id);
    if (!it || it.owner_id !== user_id || it.deleted_at) return undefined;
    it.deleted_at = new Date().toISOString();
    return it;
  }

  ackItem(user_id: string, device_id: string, id: string) {
    const it = this.items.get(id);
    if (!it || it.owner_id !== user_id) return false;
    let s = this.acks.get(id);
    if (!s) { s = new Set(); this.acks.set(id, s); }
    s.add(device_id);
    return true;
  }

  createPairing(user_id: string, req: { requester_public_key: string; requester_name: string; platform: Platform }) {
    // 6-digit code; only hash is stored
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const code_hash = createHash("sha256").update(code).digest("hex");
    const entry: PairingEntry = {
      code_hash,
      requester_device_id: randomUUID(),
      requester_public_key: req.requester_public_key,
      requester_name: req.requester_name,
      platform: req.platform,
      user_id,
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      consumed_at: null,
      code_hint: code.slice(-2),
    };
    this.pairings.set(code_hash, entry);
    return { entry, code };
  }

  confirmPairing(user_id: string, code: string) {
    const code_hash = createHash("sha256").update(String(code)).digest("hex");
    const e = this.pairings.get(code_hash);
    if (!e || e.user_id !== user_id || e.consumed_at) return undefined;
    if (Date.parse(e.expires_at) < Date.now()) return undefined;
    e.consumed_at = new Date().toISOString();
    return e;
  }

  sweepExpired(): number {
    const now = Date.now();
    let n = 0;
    for (const it of this.items.values()) {
      if (!it.deleted_at && it.expires_at && Date.parse(it.expires_at) <= now) {
        it.deleted_at = new Date().toISOString();
        n++;
      }
    }
    return n;
  }

  private enforceRetention(user_id: string) {
    const mine = [...this.items.values()]
      .filter((i) => i.owner_id === user_id && !i.deleted_at)
      .sort(compareItems);
    const over = mine.length - this.maxHistory;
    for (let k = 0; k < over; k++) {
      const oldest = mine[k];
      oldest.deleted_at = new Date().toISOString();
    }
  }

  counts() {
    return { users: this.users.size, devices: this.devices.size, items: this.items.size };
  }
}

export type Broadcast = (user_id: string, evt: SyncEvent, exceptDevice?: string) => void;
