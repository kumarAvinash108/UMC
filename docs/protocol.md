# UCM Protocol v1

`PROTOCOL_VERSION = 1`. Bump on any breaking change; clients must reject unknown major versions.

## Entities

- **User**: `{ id }` — account/auth only.
- **Device**: `{ id, user_id, name, platform: linux|android, public_key, capabilities: ("wifi-lan"|"bluetooth")[], last_seen_at, revoked_at }`.
- **ClipboardItem**: `{ id (UUIDv4, client-generated, idempotent), owner_id, source_device_id, content_type: "text/plain", ciphertext (b64), nonce (b64), metadata, created_at, expires_at, deleted_at }`.
- **LanEnvelope** (WiFi/Bluetooth P2P): `{ v: 1, transport: wifi|bluetooth, sender_device_id, sender_name?, item: ClipboardItem }` — same ciphertext, routed directly. See `docs/wifi-bluetooth.md`.

## E2E encryption (AES-256-GCM)

1. Device holds 32-byte key (Linux: secret-service keyring → 0600 file fallback; Android: Keystore-backed SecureStore).
2. For each copy: fresh 96-bit nonce, `ciphertext = AES-GCM-256(key, nonce, plaintext, aad)`.
3. **AAD** (authenticated, prevents id/device/timestamp swapping):
   `{"v":1,"id","owner_id","source_device_id","content_type","created_at"}`.
4. Upload `{id, content_type, ciphertext, nonce, metadata, expires_at}` — server validates shape/size only, **never decrypts**.
5. Reference implementations: `packages/protocol/src/crypto.ts` (Node/WebCrypto-compatible layout) and `apps/linux/src/crypto.rs` (aes-gcm crate). Android production path should use the same AAD bytes.

## Ordering & pagination

- Order key: `(created_at, id)`. Cursor = `base64url({"c": created_at, "i": id})`.
- `GET /v1/items?cursor=&limit=` (max 100). Idempotent upload: same `id` → `200` with original (first-write-wins), preventing duplicates and clipboard feedback loops.
- Clients keep a `seen_ids` set; never re-broadcast an applied item; ignore own `source_device_id` echoes.

## Pairing

1. Approved device calls `POST /v1/pairing/request` → server returns 6-digit `code` **once**, stores only `sha256(code)`, 10-min expiry.
2. New device calls `POST /v1/pairing/confirm {code}` → single-use; server creates the device and returns a key fingerprint (`sha256(public_key)` prefix) to verify on both screens.

## Realtime

- `WS /v1/sync?token=…`: server pushes `{type:"item.created",item} | {type:"item.deleted",id,deleted_at} | {type:"device.revoked",device_id}` to the user's other devices. `GET /v1/events` is a long-poll fallback hint.
- Offline: clients queue encrypted items locally (Linux: SQLite `uploaded=0`; Android: `pending=1`) and replay in `(created_at,id)` order with backoff.

## P2P transports (WiFi LAN + Bluetooth)

- Priority: wifi-lan → bluetooth → cloud. Spec: `packages/protocol/src/lan.ts`; Rust: `apps/linux/src/lan.rs` + `bluetooth.rs`; Android: `lib/{lan,bluetooth,transport}.ts`.
- WiFi: UDP beacons on `:41234`, `POST http://<host>:41235/lan/v1/items` with the `LanEnvelope`.
- Bluetooth: service `7c9e5f2a-9b3d-4a5e-9f2c-1a2b3c4d5e6f`, same envelope as `UCM1 seq/total base64` frames (512B).
- Receivers validate shape, drop cross-account `owner_id`, then decrypt via the normal AAD path. Full guide: `docs/wifi-bluetooth.md`.

## Limits (enforced server-side)

- Ciphertext ≤ 64 KiB (`413` above), history ≤ 1000/user (oldest soft-deleted), page ≤ 100, rate ≤ 120/min/token (`429`), JSON body ≤ 256 KiB.
