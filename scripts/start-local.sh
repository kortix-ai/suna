#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPABASE_DIR="$ROOT_DIR/supabase"

FRONTEND_PID=""

load_local_env() {
  # pnpm --filter runs each package from its own directory, where Bun/Next may
  # auto-load package .env files. Be explicit here: use the app env files for
  # Supabase/auth (cloud dev has Google enabled), but force only the Kortix API
  # endpoint back to localhost and mark the process as local-dev so cloud
  # provision pollers do not sweep shared remote rows.
  eval "$(python3 - "$ROOT_DIR/apps/api/.env" "$ROOT_DIR/apps/web/.env" <<'PY'
import re, shlex, sys
for path in sys.argv[1:]:
    try:
        lines = open(path, encoding='utf-8')
    except FileNotFoundError:
        continue
    with lines:
        for raw in lines:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            key = key.strip()
            if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key):
                continue
            value = value.strip().strip('"').strip("'")
            print(f'export {key}={shlex.quote(value)}')
PY
)"

  export KORTIX_LOCAL_DEV=1
  export ENV_MODE=local
  export ALLOWED_SANDBOX_PROVIDERS="local_docker, justavps"
  export KORTIX_URL="http://localhost:8008/v1/router"
  export NEXT_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export KORTIX_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export BACKEND_URL="http://localhost:8008/v1"
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

load_local_env

echo "[start] Checking Supabase configuration..."
if ! docker info >/dev/null 2>&1; then
  echo "[start] ERROR: Docker daemon is not running"
  exit 1
fi

SUPABASE_TARGET="${SUPABASE_URL:-${NEXT_PUBLIC_SUPABASE_URL:-}}"
DATABASE_TARGET="${DATABASE_URL:-}"
SUPABASE_IS_LOCAL=0
DB_IS_LOCAL=0
[[ "$SUPABASE_TARGET" == http://127.0.0.1:* || "$SUPABASE_TARGET" == http://localhost:* ]] && SUPABASE_IS_LOCAL=1
[[ "$DATABASE_TARGET" == *"127.0.0.1"* || "$DATABASE_TARGET" == *"localhost"* ]] && DB_IS_LOCAL=1

if [[ "$SUPABASE_IS_LOCAL" == "1" || "$DB_IS_LOCAL" == "1" ]]; then
  echo "[start] Ensuring local Supabase is running..."
  if ! (cd "$SUPABASE_DIR" && supabase status >/dev/null 2>&1); then
    (cd "$SUPABASE_DIR" && supabase start)
  fi
else
  echo "[start] Using configured cloud Supabase: $SUPABASE_TARGET"
fi

if [[ "$DB_IS_LOCAL" == "1" ]]; then
  echo "[start] Waiting for Postgres on 127.0.0.1:54322..."
python3 - <<'PY'
import socket
import sys
import time

deadline = time.time() + 60
while time.time() < deadline:
    try:
        with socket.create_connection(("127.0.0.1", 54322), timeout=1):
            sys.exit(0)
    except OSError:
        time.sleep(1)

print("[start] ERROR: Timed out waiting for Supabase Postgres on 127.0.0.1:54322", file=sys.stderr)
sys.exit(1)
PY
fi

echo "[start] Starting frontend (production build)..."
pnpm --filter Kortix-Computer-Frontend start &
FRONTEND_PID=$!

echo "[start] Starting API..."
cd "$ROOT_DIR"
KORTIX_SKIP_ENSURE_SCHEMA=1 pnpm --filter kortix-api start
