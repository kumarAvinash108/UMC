# Threat model (v1)

## Assets
Clipboard text (often passwords/secrets), device keys, session tokens, pairing codes.

## Trust boundaries
- **Trusted**: user's Linux desktops + Android phone (after explicit pairing + fingerprint check).
- **Untrusted**: network, sync server operator, server DB/backups, logs.

## Guarantees
- Server sees **ciphertext + routing metadata only** (ids, timestamps, sizes). Verified by test: `services/sync/src/test/api.test.ts` asserts plaintext never appears in stored items.
- Tampering with `id / owner / device / timestamp` breaks AEAD auth (AAD-bound; tested in `packages/protocol`).
- No plaintext/keys/tokens in logs (server logs method/path/status only; grep-checked in CI).

## Risks & mitigations
| Risk | Mitigation |
|---|---|
| Lost phone | Revoke device (`POST /v1/devices/{id}/revoke`); revoked tokens get `403`, WS closed; rotate account by re-pairing |
| Compromised server / DB leak | E2E AES-256-GCM; attacker gets ciphertext + metadata only |
| Revoked device replay | `revoked_at` checked on HTTP + WS; clients ignore revoked sources |
| Accidental secret copy | First-run warning; 7-day default expiry; per-item delete propagates; `Reset` wipes local keys/history |
| Clipboard loops | Origin tags + `seen_ids` + idempotent upload (first-write-wins) |
| Pairing interception (LAN) | 6-digit code is single-use, 10-min, hash-stored; fingerprint shown both sides; always use TLS in hosted mode |
| Secret-service unavailable (Linux) | 0600 file fallback; history DB stays encrypted-at-rest via E2E ciphertext |
| Android background limits | No background-clipboard promise; foreground-only sync documented in UI |

## Out of scope (v1)
Malicious client on the same account, key-rotation protocol, post-compromise recovery beyond revoke+re-pair, metadata-hiding (sizes/timing visible to server).
