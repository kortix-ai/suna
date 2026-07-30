#!/usr/bin/env bash
# Local-dev driver for the session-start latency tooling. Decrypts the local
# Supabase + DB secrets (dotenvx) and runs one of the probes against the running
# local stack (API :8008, Supabase :54321, Postgres :54322).
#
# Usage:
#   ./run.sh                 # full benchmark (session-bench.mjs)
#   ./run.sh boot-probe      # one session + daemon boot_timeline
#   ./run.sh oclog-probe     # one session + opencode.log + baked vs runtime dep versions
#   ./run.sh session-ready   # create -> runtime ready -> ACP model selection
#   ./run.sh first-token     # create -> first model-generated ACP token
#
# Target user/project default to a throwaway local e2e account. Override with
# BENCH_EMAIL / BENCH_UID / PROJECT_ID. This RESETS the target user's password
# (admin API) to sign in — local dev only, never point it at a real account.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

export SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
export API_BASE="${API_BASE:-http://localhost:8008/v1}"
export SUPABASE_SERVICE_ROLE_KEY="$(cd "$ROOT/apps/api" && npx dotenvx get SUPABASE_SERVICE_ROLE_KEY 2>/dev/null)"
export SUPABASE_ANON_KEY="$(cd "$ROOT/apps/web" && npx dotenvx get NEXT_PUBLIC_SUPABASE_ANON_KEY 2>/dev/null)"
export DATABASE_URL="$(cd "$ROOT/apps/api" && npx dotenvx get DATABASE_URL 2>/dev/null)"

export BENCH_EMAIL="${BENCH_EMAIL:-e2e-zen2-1782597409001@example.test}"
export BENCH_UID="${BENCH_UID:-af3d5ccb-44db-4937-911a-0d93ff3b0b9e}"
export PROJECT_ID="${PROJECT_ID:-344e8b40-bb13-4972-bedb-5f72c0dabf34}"

case "${1:-bench}" in
  bench)       node "$HERE/session-bench.mjs" ;;
  boot-probe)  node "$HERE/boot-probe.mjs" ;;
  oclog-probe) node "$HERE/oclog-probe.mjs" ;;
  session-ready)
    export BENCH_API="${BENCH_API:-$API_BASE}"
    export BENCH_PROJECT_ID="${BENCH_PROJECT_ID:-$PROJECT_ID}"
    export BENCH_DB_URL="${BENCH_DB_URL:-$DATABASE_URL}"
    export BENCH_STARTUP_ONLY=1
    bun "$HERE/create-to-first-token.mjs"
    ;;
  first-token)
    export BENCH_API="${BENCH_API:-$API_BASE}"
    export BENCH_PROJECT_ID="${BENCH_PROJECT_ID:-$PROJECT_ID}"
    export BENCH_DB_URL="${BENCH_DB_URL:-$DATABASE_URL}"
    bun "$HERE/create-to-first-token.mjs"
    ;;
  *)
    echo "unknown command: $1 (use: bench | boot-probe | oclog-probe | session-ready | first-token)"
    exit 1
    ;;
esac
