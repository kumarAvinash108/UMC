#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== UCM validate =="
echo "-- protocol tests --"
npm run protocol:test
echo "-- sync service tests --"
npm run sync:test
echo "-- typescript check (protocol + sync) --"
npx tsc --noEmit -p packages/protocol/tsconfig.json
npx tsc --noEmit -p services/sync/tsconfig.json
echo "OK: all checks passed"
