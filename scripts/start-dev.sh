#!/usr/bin/env bash
#
# UCM dev starter — sync service + Linux agent + Android (Expo).
#
#   ./scripts/start-dev.sh                    # everything (sync + linux + expo)
#   ./scripts/start-dev.sh --sync-only        # only the sync service (dev)
#   ./scripts/start-dev.sh --android-only     # only Expo (expects sync already up)
#   ./scripts/start-dev.sh --linux-only       # only the Linux agent (expects sync already up)
#   ./scripts/start-dev.sh --no-linux         # sync + expo, skip Linux agent
#   ./scripts/start-dev.sh --no-android       # sync + linux, skip Expo
#   ./scripts/start-dev.sh --port 3000        # sync service port (default: $PORT or 3000)
#   ./scripts/start-dev.sh --clear            # `expo start --clear` (fresh Metro cache)
#   ./scripts/start-dev.sh --no-install       # skip `npm install` check
#
# Behavior:
#   - Loads repo-root .env (creates it from .env.example if missing).
#   - Ensures JS deps are installed (root workspaces) unless --no-install.
#   - Sync service runs via `tsx` dev entry (no build step needed).
#   - Linux agent runs via `cargo run` (dev profile = fast compile).
#   - Expo runs in the FOREGROUND so QR/logs stay visible; sync+linux run as
#     background jobs and are killed automatically on Ctrl-C.
#   - Ctrl-C stops everything it started.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
PORT_FROM_CLI=0
RUN_SYNC=1
RUN_LINUX=1
RUN_ANDROID=1
CLEAR=0
NO_INSTALL=0

usage() { sed -n '1,24p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --sync-only) RUN_SYNC=1; RUN_LINUX=0; RUN_ANDROID=0; shift ;;
    --android-only) RUN_SYNC=0; RUN_LINUX=0; RUN_ANDROID=1; shift ;;
    --linux-only) RUN_SYNC=0; RUN_LINUX=1; RUN_ANDROID=0; shift ;;
    --no-linux) RUN_LINUX=0; shift ;;
    --no-android) RUN_ANDROID=0; shift ;;
    --no-sync) RUN_SYNC=0; shift ;;
    --port=*) PORT="${1#--port=}"; PORT_FROM_CLI=1; shift ;;
    --port) PORT="${2:-3000}"; PORT_FROM_CLI=1; shift 2 ;;
    --clear) CLEAR=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[dev]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

RUNDIR="$ROOT/.ucm"; mkdir -p "$RUNDIR"
SYNC_LOG="$RUNDIR/sync-dev.log"
LINUX_LOG="$RUNDIR/linux-dev.log"
PIDS=()

cleanup() {
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

# --- 0. Prereqs ---------------------------------------------------------------
have node || die "Node.js not found. Install Node 20+ then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node --version) too old — need >= 20."
[ "$RUN_LINUX" -eq 0 ] || have cargo || die "cargo not found (Linux agent requested). Re-run with --no-linux or install Rust."

if [ ! -f "$ROOT/.env" ]; then
  log "Creating .env from .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
fi
# Export companions from .env without failing on comments.
# CLI --port wins over .env PORT.
if [ "$PORT_FROM_CLI" -eq 1 ]; then
  CLI_PORT="$PORT"
  set -a
  # shellcheck disable=SC1091
  [ -f "$ROOT/.env" ] && . "$ROOT/.env" || true
  set +a
  PORT="$CLI_PORT"
else
  set -a
  # shellcheck disable=SC1091
  [ -f "$ROOT/.env" ] && . "$ROOT/.env" || true
  set +a
  PORT="${PORT:-3000}"
fi

if [ "$NO_INSTALL" -eq 0 ]; then
  if [ ! -d "$ROOT/node_modules" ]; then
    log "Installing JS workspaces (first run)…"
    (cd "$ROOT" && npm install)
  fi
else
  log "Skipping npm install (--no-install)."
fi

wait_for_health() {
  log "Waiting for http://localhost:$PORT/v1/health …"
  for _ in $(seq 1 30); do
    if curl -fsS "http://localhost:$PORT/v1/health" >/dev/null 2>&1; then
      ok "Sync service is up: http://localhost:$PORT/v1/health"
      return 0
    fi
    sleep 1
  done
  warn "Health check timed out. Last sync log lines:"
  tail -n 30 "$SYNC_LOG" || true
  return 1
}

# --- 1. Sync service (dev) ----------------------------------------------------
if [ "$RUN_SYNC" -eq 1 ]; then
  log "Starting sync service (dev) on :$PORT — log: $SYNC_LOG"
  (cd "$ROOT" && PORT="$PORT" npm run sync:dev >"$SYNC_LOG" 2>&1 & echo $! >"$RUNDIR/sync-dev.pid")
  PIDS+=("$(cat "$RUNDIR/sync-dev.pid")")
  wait_for_health || die "Sync service failed to start — see $SYNC_LOG"
fi

# --- 2. Linux agent (dev) -----------------------------------------------------
if [ "$RUN_LINUX" -eq 1 ]; then
  if [ "$RUN_SYNC" -eq 1 ]; then
    export UCM_SERVER_URL="${UCM_SERVER_URL:-http://localhost:$PORT}"
  fi
  log "Starting Linux agent (cargo run, dev) → $UCM_SERVER_URL — log: $LINUX_LOG"
  (cd "$ROOT/apps/linux" && UCM_SERVER_URL="${UCM_SERVER_URL:-http://localhost:$PORT}" \
    cargo run -q -p ucm-linux -- daemon >"$LINUX_LOG" 2>&1 & echo $! >"$RUNDIR/linux-dev.pid")
  PIDS+=("$(cat "$RUNDIR/linux-dev.pid")")
  sleep 2
  if ! kill -0 "$(cat "$RUNDIR/linux-dev.pid")" 2>/dev/null; then
    warn "Linux agent exited quickly. Last log lines:"
    tail -n 30 "$LINUX_LOG" || true
    # Don't die: sync + expo are still useful (e.g. no clipboard backend in SSH).
  else
    ok "Linux agent running (pid $(cat "$RUNDIR/linux-dev.pid"))."
  fi
fi

# --- 3. Android / Expo (foreground) -------------------------------------------
if [ "$RUN_ANDROID" -eq 1 ]; then
  log "Starting Expo dev server (foreground — Ctrl-C stops everything)…"
  if [ "$CLEAR" -eq 1 ]; then
    (cd "$ROOT/apps/android" && npx expo start --clear)
  else
    (cd "$ROOT/apps/android" && npx expo start)
  fi
  # When Expo exits (Ctrl-C), trap cleans up sync + linux.
  exit 0
fi

# --- sync-only / linux-only mode: block until Ctrl-C --------------------------
if [ "$RUN_ANDROID" -eq 0 ]; then
  log "Running without Expo. Logs: sync=$SYNC_LOG linux=$LINUX_LOG (Ctrl-C stops)."
  wait
fi
