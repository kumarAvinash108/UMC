import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encryptText, decryptText, generateKey } from "../crypto.js";
import { validateItemUpload, compareItems, encodeCursor, decodeCursor } from "../validation.js";
import { expiryToDate } from "../types.js";

describe("protocol: E2E crypto", () => {
  it("encrypt/decrypt round-trips incl. unicode + multiline", () => {
    const key = generateKey();
    const aad = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      owner_id: "u1",
      source_device_id: "d1",
      content_type: "text/plain" as const,
      created_at: new Date().toISOString(),
    };
    for (const pt of ["hello", "line1\nline2 🎉 héllo", "x".repeat(5000)]) {
      const { ciphertextB64, nonceB64 } = encryptText({ key, plaintext: pt, aad });
      assert.equal(decryptText({ key, ciphertextB64, nonceB64, aad }), pt);
    }
  });

  it("tamper detection: swapped metadata fails auth", () => {
    const key = generateKey();
    const aad = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      owner_id: "u1",
      source_device_id: "d1",
      content_type: "text/plain" as const,
      created_at: new Date().toISOString(),
    };
    const enc = encryptText({ key, plaintext: "secret", aad });
    assert.throws(() => decryptText({ key, ...enc, aad: { ...aad, source_device_id: "evil" } }));
  });
});

describe("protocol: validation + ordering", () => {
  it("rejects bad uploads", () => {
    assert.equal(validateItemUpload({}).ok, false);
    assert.equal(
      validateItemUpload({
        id: "nope",
        content_type: "text/plain",
        ciphertext: "eA==",
        nonce: "eA==",
      }).ok,
      false,
    );
  });
  it("preserves client created_at (AAD-bound) and rejects bad dates", () => {
    const good = validateItemUpload({
      id: "123e4567-e89b-12d3-a456-426614174000",
      content_type: "text/plain",
      ciphertext: "eA==",
      nonce: "eA==",
      created_at: "2024-05-01T12:00:00.000Z",
    });
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.value.created_at, "2024-05-01T12:00:00.000Z");
    const absent = validateItemUpload({
      id: "123e4567-e89b-12d3-a456-426614174000",
      content_type: "text/plain",
      ciphertext: "eA==",
      nonce: "eA==",
    });
    assert.equal(absent.ok, true);
    if (absent.ok) assert.equal(absent.value.created_at, null);
    assert.equal(
      validateItemUpload({
        id: "123e4567-e89b-12d3-a456-426614174000",
        content_type: "text/plain",
        ciphertext: "eA==",
        nonce: "eA==",
        created_at: "not-a-date",
      }).ok,
      false,
    );
  });
  it("orders by (created_at,id) and cursor round-trips", () => {
    const a = { created_at: "2024-01-01T00:00:00.000Z", id: "a" };
    const b = { created_at: "2024-01-01T00:00:01.000Z", id: "b" };
    assert.equal(compareItems(b, a) > 0, true);
    const c = encodeCursor(a.created_at, a.id);
    assert.deepEqual(decodeCursor(c), { created_at: a.created_at, id: a.id });
    assert.equal(decodeCursor("!!!"), null);
  });
  it("expiry presets", () => {
    assert.equal(expiryToDate("never"), null);
    assert.ok(expiryToDate("1h")! > new Date().toISOString());
  });
});
