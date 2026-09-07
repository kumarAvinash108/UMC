import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateBeacon,
  validateLanEnvelope,
  encodeBtFrames,
  decodeBtFrames,
  pickTransport,
  upsertPeerFromBeacon,
  expirePeers,
  BT_SERVICE_UUID,
  LAN_DISCOVERY_UDP_PORT,
  type LanEnvelope,
  type PeerInfo,
} from "../lan.js";

const item = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  owner_id: "u1",
  source_device_id: "d1",
  content_type: "text/plain" as const,
  ciphertext: Buffer.from("secret-bytes").toString("base64"),
  nonce: Buffer.from("123456789012").toString("base64"),
  metadata: {},
  created_at: new Date().toISOString(),
  expires_at: null,
  deleted_at: null,
};

describe("lan: beacons + envelopes", () => {
  it("validates beacons", () => {
    assert.equal(
      validateBeacon({
        v: 1,
        device_id: "d1",
        name: "ubuntu",
        platform: "linux",
        tcp_port: 41235,
        capabilities: ["wifi-lan"],
      }).ok,
      true,
    );
    assert.equal(
      validateBeacon({
        v: 2,
        device_id: "d1",
        name: "x",
        platform: "linux",
        tcp_port: 1,
        capabilities: [],
      }).ok,
      false,
    );
    assert.equal(validateBeacon(null).ok, false);
  });

  it("validates envelopes (ciphertext shape reused from cloud)", () => {
    const env: LanEnvelope = { v: 1, transport: "wifi", sender_device_id: "d1", item };
    assert.equal(validateLanEnvelope(env).ok, true);
    assert.equal(validateLanEnvelope({ ...env, transport: "nfc" }).ok, false);
    assert.equal(validateLanEnvelope({ ...env, item: { ...item, ciphertext: "!!!" } }).ok, false);
  });

  it("shares stable BT service UUID + discovery port with native agents", () => {
    assert.match(BT_SERVICE_UUID, /^[0-9a-f-]{36}$/);
    assert.equal(LAN_DISCOVERY_UDP_PORT, 41234);
  });
});

describe("lan: bluetooth framing", () => {
  it("round-trips small + multi-frame envelopes", () => {
    const env: LanEnvelope = { v: 1, transport: "bluetooth", sender_device_id: "d1", item };
    assert.deepEqual(decodeBtFrames(encodeBtFrames(env)), env);
    const big: LanEnvelope = {
      ...env,
      item: { ...item, ciphertext: Buffer.from("x".repeat(5000)).toString("base64") },
    };
    const frames = encodeBtFrames(big, 512);
    assert.ok(frames.length > 1);
    assert.deepEqual(decodeBtFrames([...frames].reverse()), big); // order-independent
  });

  it("rejects incomplete / corrupt frame sets", () => {
    const env: LanEnvelope = { v: 1, transport: "bluetooth", sender_device_id: "d1", item };
    const frames = encodeBtFrames(env);
    assert.throws(() => decodeBtFrames(frames.slice(0, -1)));
    assert.throws(() => decodeBtFrames(["UCM1 1/1 !!!not-base!!!"]));
  });
});

describe("lan: transport policy + peer cache", () => {
  const wifiPeer: PeerInfo = {
    device_id: "d1",
    name: "fedora",
    platform: "linux",
    host: "192.168.1.5",
    tcp_port: 41235,
    capabilities: ["wifi-lan", "bluetooth"],
    last_seen_at: new Date().toISOString(),
  };
  it("prefers wifi over bluetooth over cloud", () => {
    assert.equal(
      pickTransport(wifiPeer, { wifiEnabled: true, bluetoothEnabled: true, cloudEnabled: true }),
      "wifi",
    );
    assert.equal(
      pickTransport(wifiPeer, { wifiEnabled: false, bluetoothEnabled: true, cloudEnabled: true }),
      "bluetooth",
    );
    assert.equal(
      pickTransport(
        { ...wifiPeer, capabilities: [] },
        { wifiEnabled: true, bluetoothEnabled: true, cloudEnabled: true },
      ),
      "cloud",
    );
    assert.equal(
      pickTransport(wifiPeer, { wifiEnabled: false, bluetoothEnabled: false, cloudEnabled: false }),
      null,
    );
  });

  it("upserts + expires peers", () => {
    const peers = new Map<string, PeerInfo>();
    upsertPeerFromBeacon(
      peers,
      {
        v: 1,
        device_id: "d1",
        name: "ubuntu",
        platform: "linux",
        tcp_port: 41235,
        capabilities: ["wifi-lan"],
      },
      "192.168.1.2",
    );
    assert.equal(peers.get("d1")?.host, "192.168.1.2");
    const stale: PeerInfo = {
      ...wifiPeer,
      device_id: "old",
      last_seen_at: new Date(Date.now() - 60_000).toISOString(),
    };
    peers.set("old", stale);
    assert.deepEqual(expirePeers(peers), ["old"]);
  });
});
