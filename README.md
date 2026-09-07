# Universal Clipboard Manager (UCM)

Private, E2E-encrypted clipboard sync for **Ubuntu 24.04 / Fedora (GNOME, Wayland + X11 fallback)** and **Android (Expo dev build)** via a small HTTPS/WebSocket sync service.

> Server stores **ciphertext only** — never plaintext or keys. See `docs/protocol.md` and `docs/threat-model.md`.

## Layout

```
apps/android      # Expo Router app (history, pairing, devices, settings)
apps/linux        # Rust agent (clipboard providers, encrypted sqlite queue, sync engine)
services/sync     # Node Express+WS sync service (auth, devices, pairing, items)
packages/protocol # Shared v1 types, validation, AAD crypto helpers + tests
infra/            # Deploy helpers
docs/             # threat-model, protocol, install/build guides
docker-compose.yml
```

## Quickstart (one command)

Requires Node 20+.

```bash
cp .env.example .env
npm install
bash scripts/validate.sh   # builds + tests protocol & sync service
PORT=3000 npm run sync:dev # start sync service (in-memory store for local-network use)
```

Postgres (optional, hosted mode): `docker compose up -d postgres` (needs Docker), set `DATABASE_URL`, apply `services/sync/migrations/001_init.sql`.

## Linux agent

Requires Rust 1.75+ (not needed for server/Android dev):

```bash
cargo build --release -p ucm-linux
./target/release/ucm daemon
systemctl --user enable --now ucm  # after copying apps/linux/systemd/ucm.service to ~/.config/systemd/user/
```

See `docs/linux-install.md` for `.deb`/`.rpm` packaging.

## Android app

```bash
cd apps/android
npm install
npx expo start          # foreground sync + copy; use a dev build for native clipboard
npx expo run:android    # development build
```

See `docs/android-build.md`. Background clipboard monitoring is **not** promised (Android OS limits) — the app does foreground refresh, pull-to-refresh, offline search, and tap-to-copy.

## API (v1)

`POST /v1/auth/session` · `POST/GET /v1/devices` · `POST /v1/devices/{id}/revoke` ·
`POST /v1/pairing/request` · `POST /v1/pairing/confirm` ·
`GET/POST /v1/items` · `DELETE /v1/items/{id}` · `POST /v1/items/{id}/ack` ·
`GET /v1/events` · WS `/v1/sync?token=…`

## Defaults

Text-only v1 · 64 KiB max item · 1000-item history · 7-day expiry · 120 req/min rate limit.

## Definition of done (v1)

Install on Ubuntu + Fedora, install Android app, pair with explicit trust confirmation, sync text E2E, search/copy offline, revoke a device, and verify the server DB holds ciphertext only.
