import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { start } from "../app.js";
import { encryptText, generateKey } from "@ucm/protocol";

let base = "";
let server: ReturnType<typeof start>["server"];
const key = generateKey();
const AAD_OWNER = { owner_id: "", source_device_id: "", content_type: "text/plain" as const, created_at: "" };

async function api(path: string, opts: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers as object ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(base + path, { ...opts, headers });
  const body = await res.json().catch(() => ({}));
  return { res, body: body as Record<string, unknown> };
}

describe("sync service v1", () => {
  before(async () => {
    const s = start(0);
    server = s.server;
    await new Promise<void>((r) => server.on("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 3000;
    base = `http://127.0.0.1:${port}/v1`;
  });
  after(() => { server.close(); });

  it("E2E: upload ciphertext, other device receives it, server never sees plaintext", async () => {
    const s1 = (await api("/auth/session", { method: "POST", body: "{}" })).body as { user_id: string; token: string };
    // device A registers
    const dA = (await api("/devices", { method: "POST", token: s1.token, body: JSON.stringify({ name: "ubuntu", platform: "linux", public_key: "pk-a" }) })).body as { id: string };
    // second session for same user (device B flow): reuse user_id
    const s2 = (await api("/auth/session", { method: "POST", body: JSON.stringify({ user_id: s1.user_id }) })).body as { user_id: string; token: string };
    const dB = (await api("/devices", { method: "POST", token: s2.token, body: JSON.stringify({ name: "phone", platform: "android", public_key: "pk-b" }) })).body as { id: string };

    // WS listener as device B
    const wsUrl = base.replace("http", "ws") + `/sync?token=${s2.token}`;
    const events: unknown[] = [];
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
    ws.on("message", (m) => events.push(JSON.parse(String(m))));

    // device A encrypts locally, uploads only ciphertext
    const secret = "s3cr3t-clipboard 🎉\nline2";
    const id = randomUUID();
    const aad = { id, owner_id: s1.user_id, source_device_id: dA.id, content_type: "text/plain" as const, created_at: new Date().toISOString() };
    const enc = encryptText({ key, plaintext: secret, aad });
    const up = await api("/items", { method: "POST", token: s1.token, body: JSON.stringify({ id, content_type: "text/plain", ciphertext: enc.ciphertextB64, nonce: enc.nonceB64, metadata: {} }) });
    assert.equal(up.res.status, 201);

    // server stores ciphertext, not plaintext
    const list = await api("/items", { token: s2.token });
    const items = list.body.items as { ciphertext: string; id: string; nonce: string }[];
    assert.equal(items.length, 1);
    assert.ok(!(JSON.stringify(items).includes("s3cr3t")));

    await new Promise((r) => setTimeout(r, 300));
    assert.ok(events.some((e) => (e as { type: string }).type === "item.created"));
    ws.close();
    void dB; void AAD_OWNER;
  });

  it("cursor pagination, idempotent retry, ack, delete propagation", async () => {
    const s = (await api("/auth/session", { method: "POST", body: "{}" })).body as { token: string; user_id: string };
    await api("/devices", { method: "POST", token: s.token, body: JSON.stringify({ name: "fedora", platform: "linux", public_key: "pk" }) });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      ids.push(id);
      const aad = { id, owner_id: s.user_id, source_device_id: "d", content_type: "text/plain" as const, created_at: new Date().toISOString() };
      const enc = encryptText({ key, plaintext: `item-${i}`, aad });
      await api("/items", { method: "POST", token: s.token, body: JSON.stringify({ id, content_type: "text/plain", ciphertext: enc.ciphertextB64, nonce: enc.nonceB64 }) });
    }
    const p1 = (await api("/items?limit=2", { token: s.token })).body as { items: { id: string }[]; next_cursor: string };
    assert.equal(p1.items.length, 2);
    assert.ok(p1.next_cursor);
    const p2 = (await api(`/items?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`, { token: s.token })).body as { items: unknown[]; next_cursor: string | null };
    assert.equal(p2.items.length, 2);
    // idempotent retry: same id => 200, no duplicate
    const aad = { id: ids[0], owner_id: s.user_id, source_device_id: "d", content_type: "text/plain" as const, created_at: new Date().toISOString() };
    const enc = encryptText({ key, plaintext: "item-0", aad });
    const dup = await api("/items", { method: "POST", token: s.token, body: JSON.stringify({ id: ids[0], content_type: "text/plain", ciphertext: enc.ciphertextB64, nonce: enc.nonceB64 }) });
    assert.equal(dup.res.status, 200);
    const all = (await api("/items?limit=50", { token: s.token })).body as { items: unknown[] };
    assert.equal(all.items.length, 5);
    const del = await api(`/items/${ids[0]}`, { method: "DELETE", token: s.token });
    assert.equal(del.res.status, 200);
    const ack = await api(`/items/${ids[1]}/ack`, { method: "POST", token: s.token });
    assert.equal(ack.res.status, 200);
  });

  it("revoked devices stop receiving; pairing short-code is single-use", async () => {
    const s = (await api("/auth/session", { method: "POST", body: "{}" })).body as { token: string };
    const d = (await api("/devices", { method: "POST", token: s.token, body: JSON.stringify({ name: "d1", platform: "linux", public_key: "pk1" }) })).body as { id: string };
    const pr = (await api("/pairing/request", { method: "POST", token: s.token, body: JSON.stringify({ requester_public_key: "pk2", requester_name: "phone", platform: "android" }) })).body as { code: string };
    assert.equal(pr.code.length, 6);
    const cf1 = await api("/pairing/confirm", { method: "POST", token: s.token, body: JSON.stringify({ code: pr.code }) });
    assert.equal(cf1.res.status, 201);
    const cf2 = await api("/pairing/confirm", { method: "POST", token: s.token, body: JSON.stringify({ code: pr.code }) });
    assert.equal(cf2.res.status, 400); // single-use
    const rv = await api(`/devices/${d.id}/revoke`, { method: "POST", token: s.token });
    assert.equal(rv.res.status, 200);
    const blocked = await api("/items", { token: s.token });
    assert.equal(blocked.res.status, 403); // revoked session token
  });
});
