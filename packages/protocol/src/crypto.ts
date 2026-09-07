/**
 * Client-side E2E helpers (AES-256-GCM). Server NEVER sees keys/plaintext.
 * Uses Node WebCrypto so the same code path works in tests; Android uses
 * libsodium/Expo Crypto with identical AAD layout (see docs/protocol.md).
 */
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import type { ItemAAD } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export function buildAAD(aad: Omit<ItemAAD, "v">): Buffer {
  const full: ItemAAD = { v: PROTOCOL_VERSION, ...aad };
  return Buffer.from(JSON.stringify(full), "utf8");
}

export function encryptText(params: {
  key: Buffer; // 32 bytes
  plaintext: string;
  aad: Omit<ItemAAD, "v">;
}): { ciphertextB64: string; nonceB64: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", params.key, nonce);
  cipher.setAAD(buildAAD(params.aad));
  const ct = Buffer.concat([cipher.update(params.plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertextB64: Buffer.concat([ct, tag]).toString("base64"),
    nonceB64: nonce.toString("base64"),
  };
}

export function decryptText(params: {
  key: Buffer;
  ciphertextB64: string;
  nonceB64: string;
  aad: Omit<ItemAAD, "v">;
}): string {
  const raw = Buffer.from(params.ciphertextB64, "base64");
  if (raw.length < 17) throw new Error("ciphertext too short");
  const ct = raw.subarray(0, -16);
  const tag = raw.subarray(-16);
  const decipher = createDecipheriv("aes-256-gcm", params.key, Buffer.from(params.nonceB64, "base64"));
  decipher.setAAD(buildAAD(params.aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function generateKey(): Buffer {
  return randomBytes(32);
}
