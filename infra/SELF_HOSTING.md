# Self-hosting the sync service

## Local network (v1 default)
```bash
PORT=3000 npm run sync:dev   # in-memory store, no Postgres needed
```
Data is ephemeral (restart clears it) — fine for LAN testing; pair via `http://<lan-ip>:3000`.

## Hosted
1. Provision Postgres 16, apply `services/sync/migrations/001_init.sql`.
2. Set env: `DATABASE_URL`, `JWT_SECRET` (long random), TLS termination (Caddy/nginx), backups.
3. `docker compose up -d --build sync` (see `docker-compose.yml`).
4. Monitor `/v1/health`; alert on 4xx spikes (revoked clients) and WS disconnects.

> The provided `MemoryStore` is the reference implementation and is fully tested.
> A `PostgresStore` implementing `Store` (same interface in `services/sync/src/store.ts`) is the expected hosted swap; for multi-instance WS fan-out, publish `SyncEvent`s over Redis.
