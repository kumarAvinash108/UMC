# Universal Clipboard Manager (UCM)

Private, end-to-end encrypted clipboard sync for **Linux (Ubuntu 24.04 / Fedora, GNOME Wayland + X11)** and **Android (Expo app)** via a small HTTPS/WebSocket sync service.

> Server stores **ciphertext only** — never plaintext or keys. See `docs/protocol.md` and `docs/threat-model.md`.

**How it works in plain English:** copy text on Linux → Linux agent encrypts it locally → sync service relays the encrypted blob → your Android app decrypts it (and vice versa). Pairing uses an explicit 6-digit code + fingerprint check, so no silent joins.

---

## 1. What you need

- **Node.js 20+** (`node --version`) — required for sync server + Android app
- **Rust 1.75+** (`cargo --version`) — only for the Linux agent (skip with `--skip-linux` if you just want server/Android dev)
- **Linux:** Ubuntu 24.04 / Fedora with GNOME (Wayland or X11)
- **Android:** physical phone or emulator. For a physical phone: same Wi-Fi as your PC + Android Studio / Expo Go
- Optional: **Docker** (only for hosted Postgres mode), `curl`, `hostname -I`

Check yours:

```bash
node --version   # >= v20
cargo --version  # >= 1.75 (Linux agent only)
```

Fresh Ubuntu/Debian system libs (clipboard + build tools):

```bash
./setup-and-run.sh --install-sys-deps
# apt: build-essential pkg-config libssl-dev libsqlite3-dev wl-clipboard xclip curl
# dnf: gcc make pkg-config openssl-devel sqlite-devel wl-clipboard xclip curl
```

---

## 2. Easiest way to run it (recommended)

One idempotent command installs deps, runs tests, builds, and starts everything. Safe to re-run.

```bash
./setup-and-run.sh
```

That does:

1. Creates `.env` from `.env.example` (first run only)
2. `npm install` for all workspaces (protocol + sync + android)
3. Builds + tests protocol & sync service
4. Starts sync service in background on `http://localhost:3000`
5. Builds Linux agent with cargo (`apps/linux/target/release/ucm`)
6. Prints next steps for Android / pairing

Verify it's up:

```bash
curl http://localhost:3000/v1/health
# {"ok":true,...}
# logs: .ucm/sync.log   pid: .ucm/sync.pid
```

Stop it:

```bash
kill $(cat .ucm/sync.pid)
# or: fuser -k 3000/tcp
```

### Useful flags

```bash
./setup-and-run.sh --help
./setup-and-run.sh --foreground        # run sync in foreground (Ctrl-C stops)
./setup-and-run.sh --port 4000         # custom port
./setup-and-run.sh --skip-tests        # faster, skip validate
./setup-and-run.sh --skip-linux        # no Rust build
./setup-and-run.sh --with-expo         # also start Expo dev server
./setup-and-run.sh --with-postgres     # docker postgres instead of in-memory store
./setup-and-run.sh --install-sys-deps  # apt/dnf install system libs (needs sudo)
./setup-and-run.sh --no-install        # reuse existing node_modules
```

### Daily dev loop (hot-reload)

Use this after the first setup when you're actively coding:

```bash
npm run dev               # sync (tsx) + linux agent (cargo run) + expo (foreground)
npm run dev:sync          # only sync service
npm run dev:linux         # only Linux agent (needs sync already up)
npm run dev:android       # only Expo (needs sync already up)
```

Same thing directly:

```bash
./scripts/start-dev.sh --sync-only
./scripts/start-dev.sh --android-only
./scripts/start-dev.sh --linux-only
./scripts/start-dev.sh --no-linux   # sync + expo
```

---

## 3. How to actually use it (end-to-end in 5 min)

### Step A — Start the sync server

```bash
./setup-and-run.sh
curl http://localhost:3000/v1/health
```

### Step B — Start the Linux agent

```bash
UCM_SERVER_URL=http://localhost:3000 ./apps/linux/target/release/ucm daemon
```

Now **just copy any text** (`Ctrl+C`) on Linux — the agent encrypts + queues it offline in `~/.local/share/ucm/history.db` and syncs when online.

Run at login (systemd user service):

```bash
sudo install -m755 apps/linux/target/release/ucm /usr/local/bin/ucm
mkdir -p ~/.config/systemd/user
cp apps/linux/systemd/ucm.service ~/.config/systemd/user/ucm.service
systemctl --user daemon-reload
systemctl --user enable --now ucm
journalctl --user -u ucm -f   # watch logs
```

Full details: `docs/linux-install.md`.

### Step C — Start the Android app

```bash
cd apps/android
npx expo start
# scan QR with Expo Go / dev build, or press `a` for emulator
```

In the app you get 4 tabs:

- **History** — search offline, pull-to-refresh, tap any item to copy
- **Pairing** — enter the 6-digit code from your other device
- **Devices** — list + revoke lost/stolen devices
- **Settings** — server URL, sync toggle, reset

> Android OS blocks background clipboard reads, so the app syncs in the **foreground**: open app → auto-refresh + live WebSocket updates while open → tap-to-copy. This is intentional, see `docs/android-build.md`.

### Step D — Pair your devices (do this once)

1. On device 1: `POST /v1/pairing/request` → server returns a 6-digit code.
2. On device 2: enter code in app (Pairing tab) or `POST /v1/pairing/confirm`.
3. **Verify the fingerprint shown on both screens matches**, then confirm.
4. Copy text on one device → it appears in History on the other in ~1s (same LAN).

### Step E — Everyday usage

| I want to… | How |
|---|---|
| Sync Linux → Android | Copy on Linux, open Android app → History updates |
| Sync Android → Linux | Copy in app (tap-to-copy), paste on Linux |
| Find old copy | History tab → search box works offline |
| Remove a device | Devices tab → Revoke, or `POST /v1/devices/{id}/revoke` |
| Work offline | Both sides queue encrypted; syncs on reconnect |
| Start over | Linux: `ucm reset` (type YES) · Android: Settings → Reset |

### Connecting a physical phone (most common gotcha)

`localhost` on your phone = the phone itself, not your PC. Use your PC's LAN IP:

```bash
hostname -I   # e.g. 192.168.1.5
curl http://192.168.1.5:3000/v1/health   # must work from PC first
echo 'EXPO_PUBLIC_SYNC_URL=http://192.168.1.5:3000' > apps/android/.env
cd apps/android && npx expo start -c
```

Checklist: same Wi-Fi, server bound to `0.0.0.0` / LAN IP, phone can `curl` health, re-check IP after router reconnects (DHCP changes it). For the Linux agent on LAN: `UCM_SERVER_URL=http://192.168.1.5:3000`.

---

## 4. Other ways to run

**Docker (hosted mode with Postgres):**

```bash
docker compose up --build
# sync on :3000, postgres on :5432
# set JWT_SECRET in .env first!
```

Postgres is optional — without `DATABASE_URL` the service uses an in-memory store (fine for local/LAN dev). For hosted mode: `docker compose up -d postgres`, set `DATABASE_URL`, apply `services/sync/migrations/001_init.sql`.

**Manual (no scripts):**

```bash
npm install
npm run protocol:test
npm run sync:test
npm run sync:dev          # dev server with tsx
# or build: (cd services/sync && npx tsc -p tsconfig.json) && node services/sync/dist/index.js
cargo build --release -p ucm-linux
```

---

## 5. Project layout

```
apps/android      # Expo Router app (history, pairing, devices, settings)
apps/linux        # Rust agent (clipboard providers, encrypted sqlite queue, sync engine)
services/sync     # Node Express+WS sync service (auth, devices, pairing, items)
packages/protocol # Shared v1 types, validation, AAD crypto helpers + tests
infra/            # Deploy helpers
docs/             # threat-model, protocol, install/build guides
docker-compose.yml
setup-and-run.sh  # one-command setup
scripts/start-dev.sh  # daily dev loop
```

Docs: `docs/protocol.md` · `docs/threat-model.md` · `docs/linux-install.md` · `docs/android-build.md` · `docs/wifi-bluetooth.md`

API (v1): `POST /v1/auth/session` · `POST/GET /v1/devices` · `POST /v1/devices/{id}/revoke` · `POST /v1/pairing/request` · `POST /v1/pairing/confirm` · `GET/POST /v1/items` · `DELETE /v1/items/{id}` · `POST /v1/items/{id}/ack` · `GET /v1/events` · WS `/v1/sync?token=…`

Defaults: text-only v1 · 64 KiB max item · 1000-item history · 7-day expiry · 120 req/min rate limit.

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `Node too old` | Install Node 20+: https://nodejs.org |
| `cargo not found` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` or `--skip-linux` |
| Sync won't start | `tail -n 50 .ucm/sync.log`, `fuser -k 3000/tcp`, retry with `--foreground` |
| `Network request failed` on phone | Use LAN IP (see above), same Wi-Fi, `npx expo start -c` |
| No clipboard on Linux Wayland | Need active GNOME session, `echo $WAYLAND_DISPLAY`, keep `After=graphical-session.target` |
| No sync | `curl $UCM_SERVER_URL/v1/health`, check token in `~/.local/share/ucm/history.db` |
| Port busy | `./setup-and-run.sh --port 4000` |
| Nuclear reset | `ucm reset` (type YES) + revoke old device from phone, delete `.ucm/*.log` |

Validate everything still passes after changes:

```bash
bash scripts/validate.sh
```

## Definition of done (v1)

Install on Ubuntu + Fedora, install Android app, pair with explicit trust confirmation, sync text E2E, search/copy offline, revoke a device, and verify the server DB holds ciphertext only.
