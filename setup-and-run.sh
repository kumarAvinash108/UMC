#!/usr/bin/env bash
#
# UCM — install + run everything with one command.
#
#   ./setup-and-run.sh [options]
#
# What it does (idempotent, safe to re-run):
#   1. Checks OS + Node 20+, Rust (optional), Docker (optional)
#   2. Optionally installs system deps (apt/dnf, needs sudo)
#   3. Creates .env from .env.example if missing
#   4. npm install (root workspaces: protocol + sync + android deps)
#   5. Builds + tests protocol & sync service (unless --skip-tests)
#   6. Builds sync service and starts it (background by default, --foreground to block)
#   7. Builds Linux agent with cargo if available (unless --skip-linux)
#   8. Prints Android / pairing next steps (starts Expo only with --with-expo)
#
# Options:
#   --port N            Sync service port (default: $PORT or 3000)
#   --foreground        Run sync service in foreground (logs to console, Ctrl-C stops)
#   --skip-tests        Skip validate/build-test step (faster)
#   --skip-linux        Skip Rust Linux-agent build
#   --skip-android      Skip Android dep check
#   --with-expo         Also start `expo start` for the Android app (blocking)
#   --with-postgres     `docker compose up -d postgres` before starting sync
#   --install-sys-deps  apt/dnf install system libs (clipboard, build tools) via sudo
#   --no-install        Skip npm install (use existing node_modules)
#   -h, --help          Show this help
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
FOREGROUND=0
SKIP_TESTS=0
SKIP_LINUX=0
SKIP_ANDROID=0
WITH_EXPO=0
WITH_POSTGRES=0
INSTALL_SYS_DEPS=0
NO_INSTALL=0

usage() { sed -n '1,26p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port=*) PORT="${1#--port=}"; shift ;;
    --port) PORT="${2:-3000}"; shift 2 ;;
    --foreground) FOREGROUND=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --skip-linux) SKIP_LINUX=1; shift ;;
    --skip-android) SKIP_ANDROID=1; shift ;;
    --with-expo) WITH_EXPO=1; shift ;;
    --with-postgres) WITH_POSTGRES=1; shift ;;
    --install-sys-deps) INSTALL_SYS_DEPS=1; shift ;;
    --no-install) NO_INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[ucm]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

detect_pkg_mgr() {
  if have apt-get; then echo apt;
  elif have dnf; then echo dnf;
  elif have yum; then echo yum;
  else echo none; fi
}

# --- 1. Prereqs ---------------------------------------------------------------
log "Repo root: $ROOT (port $PORT)"
OS="$(uname -s)"; ARCH="$(uname -m)"
log "OS: $OS $ARCH"

if ! have node; then
  die "Node.js not found. Install Node 20+ (https://nodejs.org) then re-run."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node $(node --version) too old — need >= 20."
fi
ok "Node $(node --version), npm $(npm --version)"

if ! have cargo && [ "$SKIP_LINUX" -eq 0 ]; then
  warn "Rust/cargo not found — Linux agent build will be skipped."
  warn "  Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  warn "  Or re-run with --skip-linux to silence this."
  SKIP_LINUX=1
fi

# --- 2. Optional system deps ---------------------------------------------------
if [ "$INSTALL_SYS_DEPS" -eq 1 ]; then
  PM="$(detect_pkg_mgr)"
  log "Installing system deps via $PM (sudo required)…"
  case "$PM" in
    apt) sudo apt-get update && sudo apt-get install -y build-essential pkg-config libssl-dev libsqlite3-dev wl-clipboard xclip curl ;;
    dnf|yum) sudo "$PM" install -y gcc gcc-c++ make pkg-config openssl-devel sqlite-devel wl-clipboard xclip curl ;;
    *) warn "No supported package manager — skipping system deps." ;;
  esac
fi

# --- 3. Env file ----------------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  log "Creating .env from .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
  ok ".env created — edit JWT_SECRET / IPs for LAN use."
else
  ok ".env exists, leaving it alone."
fi

# --- 4. Install JS deps ----------------------------------------------------------
if [ "$NO_INSTALL" -eq 0 ]; then
  log "Installing JS workspaces (protocol, sync-service, android)…"
  (cd "$ROOT" && npm install)
  ok "npm install done."
else
  log "Skipping npm install (--no-install)."
fi

# --- 5. Validate -----------------------------------------------------------------
if [ "$SKIP_TESTS" -eq 0 ]; then
  log "Validating: protocol + sync tests + typecheck…"
  (cd "$ROOT" && bash scripts/validate.sh)
  ok "Validate passed."
else
  log "Skipping tests (--skip-tests). Building sync service only…"
  (cd "$ROOT/services/sync" && npx tsc -p tsconfig.json)
fi

# --- 6. Optional Postgres ----------------------------------------------------------
if [ "$WITH_POSTGRES" -eq 1 ]; then
  if have docker; then
    log "Starting postgres via docker compose…"
    (cd "$ROOT" && docker compose up -d postgres)
    ok "Postgres started (apply services/sync/migrations/001_init.sql for hosted mode)."
  else
    warn "Docker not found — cannot start postgres. Continuing with in-memory store."
  fi
fi

# --- 7. Start sync service ----------------------------------------------------------
RUNDIR="$ROOT/.ucm"; mkdir -p "$RUNDIR"
LOGFILE="$RUNDIR/sync.log"; PIDFILE="$RUNDIR/sync.pid"

stop_existing() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "Stopping previous sync service (pid $(cat "$PIDFILE"))…"
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    sleep 1
  fi
  # Free the port if something else holds it
  if have fuser; then fuser -k "$PORT/tcp" 2>/dev/null || true; fi
}

wait_for_health() {
  log "Waiting for http://localhost:$PORT/v1/health …"
  for i in $(seq 1 30); do
    if curl -fsS "http://localhost:$PORT/v1/health" >/dev/null 2>&1; then
      ok "Sync service is up: http://localhost:$PORT/v1/health"
      curl -s "http://localhost:$PORT/v1/health"; echo
      return 0
    fi
    sleep 1
  done
  warn "Health check timed out. Last log lines:"
  tail -n 30 "$LOGFILE" || true
  return 1
}

if [ "$FOREGROUND" -eq 1 ]; then
  log "Starting sync service in FOREGROUND (Ctrl-C to stop)…"
  PORT="$PORT" node "$ROOT/services/sync/dist/index.js"
  exit 0
fi

stop_existing
log "Starting sync service in background (log: $LOGFILE)…"
PORT="$PORT" nohup node "$ROOT/services/sync/dist/index.js" >"$LOGFILE" 2>&1 &
echo $! > "$PIDFILE"
if ! wait_for_health; then
  die "Sync service failed to start — see $LOGFILE"
fi

# --- 8. Linux agent -----------------------------------------------------------------
if [ "$SKIP_LINUX" -eq 0 ]; then
  log "Building Linux agent (cargo build --release)…"
  if (cd "$ROOT/apps/linux" && cargo build --release); then
    ok "Linux agent built: apps/linux/target/release/ucm"
    log "Run it with: UCM_SERVER_URL=http://localhost:$PORT ./apps/linux/target/release/ucm daemon"
  else
    warn "Linux agent build failed — server still running. See output above."
    warn "  Tip: re-run with --install-sys-deps (needs libssl/sqlite/X11 dev libs)."
  fi
else
  log "Skipping Linux agent build."
fi

# --- 9. Android -----------------------------------------------------------------------
if [ "$SKIP_ANDROID" -eq 0 ]; then
  if [ -d "$ROOT/apps/android/node_modules" ] || [ -d "$ROOT/node_modules/expo" ]; then
    ok "Android deps present (installed via workspaces)."
  else
    warn "Android deps not detected (expo not in node_modules). They install with root 'npm install'."
  fi
  if [ "$WITH_EXPO" -eq 1 ]; then
    log "Starting Expo dev server…"
    (cd "$ROOT/apps/android" && npx expo start)
    exit 0
  else
    log "Android: start when ready → cd apps/android && npx expo start"
  fi
else
  log "Skipping Android check."
fi

# --- 10. Summary ------------------------------------------------------------------------
cat <<EOF

──────────────────────────────────────────────
 UCM is running 🎉
──────────────────────────────────────────────
 Sync API : http://localhost:$PORT/v1/health
 Logs     : $LOGFILE   (pid $(cat "$PIDFILE"))
 Stop     : kill \$(cat $PIDFILE)  (or: fuser -k $PORT/tcp)

 Next steps:
   1. Linux agent : UCM_SERVER_URL=http://localhost:$PORT ./apps/linux/target/release/ucm daemon
      (install as user service: see docs/linux-install.md)
   2. Android     : cd apps/android && npx expo start
      (foreground refresh + tap-to-copy; background sync not promised by Android OS)
   3. Pair        : server returns a 6-digit code via POST /v1/pairing/request;
                    confirm on the 2nd device via POST /v1/pairing/confirm,
                    verify the fingerprint on both screens.
   4. LAN phones  : set EXPO_PUBLIC_SYNC_URL + UCM_SERVER_URL to http://<your-lan-ip>:$PORT

 Flags: --foreground --skip-tests --skip-linux --skip-android --with-expo
        --with-postgres --install-sys-deps --no-install --port N
──────────────────────────────────────────────
EOF
