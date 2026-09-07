# WiFi + Bluetooth direct sync (UCM P2P transport)

Cloud relay works anywhere but round-trips every keystroke through a server.
On a home/office network — or with no network at all — UCM devices sync
**directly**: WiFi LAN when both are on the same network, Bluetooth when
they aren't. Priority is always **wifi → bluetooth → cloud**, and every
transport carries the _same E2E ciphertext_ (AES-256-GCM, AAD-bound). No
transport ever sees plaintext.

```
┌──────────┐   WiFi LAN (UDP 41234 beacon + HTTP POST :41235)   ┌──────────┐
│  Ubuntu  │ ─────────────────────────────────────────────────▶ │ Android  │
│  agent   │ ◀───────────────────────────────────────────────── │   app    │
└──────────┘   Bluetooth (service 7c9e5f2a-… + UCM1 framing)    └──────────┘
        │              Cloud relay (ciphertext only)                   │
        └──────────────────────▶ sync service ◀───────────────────────┘
```

## 1. Quickstart

**Step 0 — one shared sync key (required, do this first):**
Clipboard items are end-to-end encrypted, so every device must hold the

- same 32-byte key — pairing alone does not exchange it (the server never
  sees keys). On Linux run `ucm key-show`, then in the Android app open
  **Settings → Sync key**, paste it, and save. The fingerprints must match
  on both sides. Without this, devices connect fine but every item fails to
  decrypt (the app tells you how many were skipped).

**Same WiFi (fastest):**

1. On Linux: `ucm daemon` (starts the LAN listener automatically), or `ucm lan-serve` for LAN-only mode.
2. Find the PC's LAN IP: `hostname -I` (e.g. `192.168.1.5` — never `localhost`, that's the phone itself).
3. On Android: **Settings → WiFi peers →** enter the IP → **Add** → **Ping** should answer.
4. Copy text on Linux — it arrives via LAN (check `ucm` logs for `lan broadcast`), cloud stays as backstop.

**Bluetooth (no WiFi):**

1. Linux: `ucm bt-status` — needs an adapter (`bluetoothctl power on` if unpowered).
2. Android: needs a **dev build** with `react-native-ble-plx` (Expo Go has no BLE); without it the app stages envelopes in an outbox and tells you.
3. Pair in system Bluetooth settings first; UCM discovers service `7c9e5f2a-9b3d-4a5e-9f2c-1a2b3c4d5e6f`.

**Check the policy:** `ucm transport` prints wifi/bt/cloud switches, ports, radio state.
Disable a link any time: `UCM_WIFI_ENABLED=false`, `UCM_BT_ENABLED=false`, or the toggles in Android Settings.

## 2. How it works

| Piece     | WiFi LAN                                                                                               | Bluetooth                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Discovery | UDP broadcast beacons (`255.255.255.255:41234`, 5s) with device id, name, tcp port, capabilities       | BLE advertisement of service `7c9e5f2a-…`                                                                                       |
| Transfer  | `POST http://<host>:41235/lan/v1/items` (envelope JSON)                                                | Same envelope JSON split into `UCM1 seq/total base64` frames (512B, blank-line terminator) over RFCOMM / GATT char `7c9e5f2b-…` |
| Health    | `GET /lan/v1/health`                                                                                   | `bluetoothctl` / sysfs probe + `ucm bt-status`                                                                                  |
| Security  | Ciphertext only; receiver drops envelopes whose `owner_id` ≠ own user; AES-GCM AAD still authenticates | Same — framing adds no crypto                                                                                                   |

Shared spec: `packages/protocol/src/lan.ts` (TS) = `apps/linux/src/lan.rs` + `bluetooth.rs` (Rust) = `apps/android/lib/{lan,bluetooth,transport}.ts`.
Change the framing or ports in one place? Change them in all four — tests assert the constants match (`BT_SERVICE_UUID`, `41234`).

## 3. CLI reference

- `ucm daemon` — full agent: clipboard watch + cloud WS + LAN announce/discover/serve + BT status.
- `ucm transport` — policy + ports + radio state.
- `ucm lan-peers [--timeout 6]` — listen for beacons, print peers with chosen transport.
- `ucm lan-send --host 192.168.1.5 [--port 41235] "text"` — encrypt + push one item to a peer.
- `ucm lan-serve` — LAN-only listener (logs `lan rx id=…`, never content).
- `ucm bt-status` — radio, service/char UUIDs, framing info.
- `ucm bt-send "text" [--tcp host:port]` — stage envelope as BT frames; with `--tcp` writes the exact bytes an RFCOMM socket would carry (test with `nc -l`).

## 4. Android notes

- **Expo Go:** WiFi LAN + cloud work; Bluetooth reports _unavailable_ (OS limitation, surfaced in Settings — not a silent failure).
- **Dev build:** add `react-native-ble-plx`, rebuild (`npx expo run:android`), BLE path activates automatically.
- `lib/transport.ts:fanOut()` sends over every enabled link and returns `{wifi, bluetooth, cloud, errors}` — failures are reported, never thrown, so the offline queue stays the backstop.

## 5. Troubleshooting

- **No LAN peers:** same WiFi _and_ band (2.4 vs 5 GHz AP isolation blocks UDP broadcast)? Firewall (`ufw allow 41234/udp && ufw allow 41235/tcp`)? `ucm lan-peers` on both machines narrows it down.
- **Phone can't reach PC:** you used `localhost` — use the PC's LAN IP from `hostname -I`. Also check `EXPO_PUBLIC_SYNC_URL` for the cloud path.
- **Bluetooth unavailable:** VM/container with no radio — expected; WiFi/cloud still work. On hardware: `bluetoothctl power on`, then `ucm bt-status`.
- **Cross-account envelope ignored:** LAN has no server auth, so the engine only applies envelopes whose `owner_id` matches its own user (`warn` in logs). Pair via the cloud flow first.
