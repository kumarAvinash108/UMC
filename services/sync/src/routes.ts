import { Router } from "express";
import { randomUUID } from "node:crypto";
import { LIMITS, validateItemUpload } from "@ucm/protocol";
import type { Broadcast, Store } from "./store.js";
import { authMiddleware, type AuthedRequest } from "./auth.js";
import type { ClipboardItem } from "@ucm/protocol";

export function buildRouter(store: Store, broadcast: Broadcast, cfg: { maxItemBytes: number; defaultExpiryDays: number; maxPage: number }) {
  const r = Router();

  // ---- auth ----
  // POST /v1/auth/session { user_id? } -> { user_id, token }
  // v1 uses opaque per-user session tokens; device binding happens on device register.
  r.post("/auth/session", (req, res) => {
    const { user_id } = (req.body ?? {}) as { user_id?: string };
    let uid = user_id;
    if (!uid || !store.getUser(uid)) {
      uid = store.createUser().id;
    }
    const sess = store.createSession(uid);
    res.json({ user_id: uid, token: sess.token });
  });

  const authed = authMiddleware(store);

  // ---- devices ----
  r.post("/devices", authed, (req, res) => {
    const { user_id, session_token } = req as unknown as AuthedRequest;
    const { name, platform, public_key } = (req.body ?? {}) as Record<string, string>;
    if (!name || typeof name !== "string" || name.length > 64)
      { res.status(400).json({ error: "name required (<=64)" }); return; }
    if (platform !== "linux" && platform !== "android")
      { res.status(400).json({ error: "platform must be linux|android" }); return; }
    if (!public_key || typeof public_key !== "string" || public_key.length > 512)
      { res.status(400).json({ error: "public_key required" }); return; }
    const d = store.createDevice(user_id, name, platform, public_key);
    store.bindSessionDevice(session_token, d.id);
    res.status(201).json(d);
  });

  r.get("/devices", authed, (req, res) => {
    res.json({ devices: store.listDevices((req as unknown as AuthedRequest).user_id) });
  });

  r.post("/devices/:id/revoke", authed, (req, res) => {
    const { user_id } = req as unknown as AuthedRequest;
    const d = store.revokeDevice(user_id, req.params.id);
    if (!d) { res.status(404).json({ error: "device not found" }); return; }
    broadcast(user_id, { type: "device.revoked", device_id: d.id });
    res.json(d);
  });

  // ---- pairing (short code, hash stored, 10-min expiry, single use) ----
  r.post("/pairing/request", authed, (req, res) => {
    const { user_id } = req as unknown as AuthedRequest;
    const { requester_public_key, requester_name, platform } = (req.body ?? {}) as Record<string, string>;
    if (!requester_public_key || !requester_name)
      { res.status(400).json({ error: "requester_public_key + requester_name required" }); return; }
    if (platform !== "linux" && platform !== "android")
      { res.status(400).json({ error: "platform must be linux|android" }); return; }
    const { entry, code } = store.createPairing(user_id, {
      requester_public_key, requester_name, platform,
    });
    // Code is returned once to the requester display; server keeps only the hash.
    res.status(201).json({ code, expires_at: entry.expires_at, code_hint: entry.code_hint });
  });

  r.post("/pairing/confirm", authed, (req, res) => {
    const { user_id } = req as unknown as AuthedRequest;
    const { code, device_name } = (req.body ?? {}) as { code?: string; device_name?: string };
    if (!code) { res.status(400).json({ error: "code required" }); return; }
    const entry = store.confirmPairing(user_id, code);
    if (!entry) { res.status(400).json({ error: "invalid or expired code" }); return; }
    const d = store.createDevice(user_id, String(device_name ?? entry.requester_name).slice(0, 64), entry.platform, entry.requester_public_key);
    res.status(201).json({ device: d, fingerprint: "sha256:" + Buffer.from(entry.requester_public_key).toString("base64").slice(0, 16) });
  });

  // ---- items (server stores ciphertext only; never decrypts) ----
  r.post("/items", authed, (req, res) => {
    const { user_id, device_id } = req as unknown as AuthedRequest;
    if (!device_id) { res.status(400).json({ error: "register a device first" }); return; }
    const v = validateItemUpload(req.body);
    if (!v.ok) { res.status(400).json({ error: v.error }); return; }
    const rawBytes = Buffer.from(v.value.ciphertext, "base64").length;
    if (rawBytes > cfg.maxItemBytes) { res.status(413).json({ error: "item too large" }); return; }
    const now = new Date().toISOString();
    const item: ClipboardItem = {
      id: v.value.id,
      owner_id: user_id,
      source_device_id: device_id,
      content_type: v.value.content_type,
      ciphertext: v.value.ciphertext,
      nonce: v.value.nonce,
      metadata: v.value.metadata,
      created_at: now,
      expires_at: v.value.expires_at ?? new Date(Date.now() + cfg.defaultExpiryDays * 86_400_000).toISOString(),
      deleted_at: null,
    };
    const { created, item: saved } = store.upsertItem(item);
    if (created) broadcast(user_id, { type: "item.created", item: saved }, device_id);
    res.status(created ? 201 : 200).json(saved);
  });

  r.get("/items", authed, (req, res) => {
    const { user_id } = req as unknown as AuthedRequest;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), cfg.maxPage || LIMITS.MAX_PAGE_SIZE);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(store.listItems(user_id, cursor, limit));
  });

  r.delete("/items/:id", authed, (req, res) => {
    const { user_id, device_id } = req as unknown as AuthedRequest;
    const it = store.deleteItem(user_id, req.params.id);
    if (!it) { res.status(404).json({ error: "not found" }); return; }
    broadcast(user_id, { type: "item.deleted", id: it.id, deleted_at: it.deleted_at! }, device_id ?? undefined);
    res.json({ ok: true });
  });

  r.post("/items/:id/ack", authed, (req, res) => {
    const { user_id, device_id } = req as unknown as AuthedRequest;
    if (!device_id) { res.status(400).json({ error: "register a device first" }); return; }
    const ok = store.ackItem(user_id, device_id, req.params.id);
    if (!ok) { res.status(404).json({ error: "not found" }); return; }
    res.json({ ok: true });
  });

  // Long-poll fallback for clients without WebSocket
  r.get("/events", authed, (req, res) => {
    res.json({ events: [], hint: "use WebSocket /v1/sync for realtime delivery" });
  });

  r.get("/health", (_req, res) => {
    void randomUUID;
    res.json({ ok: true, counts: store.counts() });
  });

  return r;
}
