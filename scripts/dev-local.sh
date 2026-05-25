#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPABASE_DIR="$ROOT_DIR/supabase"

FRONTEND_PID=""
TUNNEL_PID=""
TUNNEL_LOG=""

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
  # `local_docker` was removed when we consolidated on cloud — listing it here
  # only made the API log "Unknown sandbox provider" twice on every boot.
  export ALLOWED_SANDBOX_PROVIDERS="daytona"
  # KORTIX_URL is resolved by ensure_dev_tunnel() below. Cloud (Daytona)
  # sandboxes call BACK to it (LLM router, web search, RPC) and cannot reach
  # this machine's localhost — so they need a public tunnel URL. The dashboard
  # keeps talking to the API on localhost via NEXT_PUBLIC_BACKEND_URL, so only
  # the sandbox -> API direction goes through the tunnel.
  export NEXT_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export KORTIX_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export BACKEND_URL="http://localhost:8008/v1"
}

# Front the local API with a public Cloudflare quick tunnel so cloud Daytona
# sandboxes can reach it as $KORTIX_URL. No-op when sandboxes run locally
# (local_docker default) or when KORTIX_DEV_TUNNEL=0.
ensure_dev_tunnel() {
  local api_port="${PORT:-8008}"
  local api_origin="http://localhost:${api_port}"
  local default_provider="${ALLOWED_SANDBOX_PROVIDERS%%,*}"

  # Respect an explicit public KORTIX_URL (named tunnel, staging API, …).
  if [[ -n "${KORTIX_URL:-}" && "$KORTIX_URL" != http://localhost:* && "$KORTIX_URL" != http://127.0.0.1:* ]]; then
    echo "[dev] Using KORTIX_URL from environment: $KORTIX_URL"
    return 0
  fi

  # Local-docker sandboxes run on this machine — no public callback needed.
  # Honor an explicit opt-out too.
  if [[ "${KORTIX_DEV_TUNNEL:-auto}" == "0" || "$default_provider" != "daytona" ]]; then
    export KORTIX_URL="$api_origin"
    echo "[dev] Tunnel skipped — KORTIX_URL=$KORTIX_URL"
    if [[ "$default_provider" == "daytona" ]]; then
      echo "[dev] ⚠️  Default sandbox provider is Daytona (cloud) but the tunnel is off —"
      echo "[dev]     sessions will fail with 'OpenCode runtime is not ready' because the"
      echo "[dev]     sandbox cannot reach $api_origin. Unset KORTIX_DEV_TUNNEL to enable it."
    fi
    return 0
  fi

  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "[dev] ERROR: cloudflared is required for cloud (Daytona) sandboxes but was not found."
    echo "[dev]        Cloud sandboxes can't reach localhost; they need a public KORTIX_URL."
    echo "[dev]        Install:  brew install cloudflared"
    echo "[dev]        Or:       KORTIX_DEV_TUNNEL=0 pnpm dev   (uses local_docker sandboxes only)"
    exit 1
  fi

  TUNNEL_LOG="$(mktemp -t kortix-tunnel.XXXXXX)"
  echo "[dev] Starting Cloudflare quick tunnel → $api_origin ..."
  cloudflared tunnel --no-autoupdate --url "$api_origin" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!

  local url=""
  local i
  for i in $(seq 1 30); do
    url="$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
    [[ -n "$url" ]] && break
    if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      echo "[dev] ERROR: cloudflared exited early:"
      sed 's/^/[cloudflared] /' "$TUNNEL_LOG"
      exit 1
    fi
    sleep 1
  done

  if [[ -z "$url" ]]; then
    echo "[dev] ERROR: timed out waiting for the Cloudflare tunnel URL:"
    sed 's/^/[cloudflared] /' "$TUNNEL_LOG"
    exit 1
  fi

  export KORTIX_URL="$url"
  echo "[dev] ✅ Cloud sandbox callback ready: KORTIX_URL=$KORTIX_URL"
}

# Cross-compile the in-sandbox daemon (kortix-agent, Linux x64) so a fresh
# `pnpm dev` always bakes the latest daemon into new snapshots. Lazy: only
# rebuilds when a source file is newer than the existing binary (or it's
# missing), so API-only restarts pay nothing. A build failure warns but does
# not abort dev — the previous binary stays in place.
ensure_agent_binary() {
  local dir="$ROOT_DIR/apps/kortix-sandbox-agent-server"
  local bin="$dir/dist/kortix-agent"

  if [[ -f "$bin" ]]; then
    local newer
    newer="$(find "$dir/src" "$dir/scripts" "$dir/package.json" -type f -newer "$bin" -print -quit 2>/dev/null || true)"
    if [[ -z "$newer" ]]; then
      echo "[dev] kortix-agent up to date — skipping daemon build"
      return 0
    fi
    echo "[dev] kortix-agent stale (changed: ${newer#"$dir"/}) — rebuilding…"
  else
    echo "[dev] kortix-agent missing — building…"
  fi

  if (cd "$dir" && bun run build); then
    echo "[dev] ✅ kortix-agent (Linux x64) rebuilt — new snapshots will bake it"
  else
    echo "[dev] ⚠️  kortix-agent build failed — new snapshots may bake a stale daemon"
  fi
}

kill_dev_ports() {
  local ports=()
  local port
  local seen

  for port in "$@"; do
    [[ -n "$port" ]] || continue
    seen="0"
    # Bash 3.2 (macOS default) + set -u trips on "${ports[@]}" when the
    # array is empty. Guard with a length check so the dedup loop only
    # runs once we've actually accumulated something.
    if [[ ${#ports[@]} -gt 0 ]]; then
      local existing
      for existing in "${ports[@]}"; do
        if [[ "$existing" == "$port" ]]; then
          seen="1"
          break
        fi
      done
    fi
    [[ "$seen" == "0" ]] && ports+=("$port")
  done

  [[ ${#ports[@]} -gt 0 ]] || return 0

  for port in "${ports[@]}"; do
    local pids
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "$pids" ]] || continue

    echo "[dev] Clearing stale listener(s) on port $port: ${pids//$'\n'/ }"
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      kill "$pid" 2>/dev/null || true
    done <<< "$pids"

    sleep 1

    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [[ -n "$pids" ]] || continue
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      kill -9 "$pid" 2>/dev/null || true
    done <<< "$pids"
  done
}

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null || true
    wait "$FRONTEND_PID" 2>/dev/null || true
  fi

  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi
  [[ -n "${TUNNEL_LOG:-}" && -f "${TUNNEL_LOG:-}" ]] && rm -f "$TUNNEL_LOG"

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

load_local_env
kill_dev_ports 3000 8008 "${PORT:-8008}"

echo "[dev] Checking Supabase configuration..."
if ! docker info >/dev/null 2>&1; then
  echo "[dev] ERROR: Docker daemon is not running"
  exit 1
fi

SUPABASE_TARGET="${SUPABASE_URL:-${NEXT_PUBLIC_SUPABASE_URL:-}}"
DATABASE_TARGET="${DATABASE_URL:-}"
SUPABASE_IS_LOCAL=0
DB_IS_LOCAL=0
[[ "$SUPABASE_TARGET" == http://127.0.0.1:* || "$SUPABASE_TARGET" == http://localhost:* ]] && SUPABASE_IS_LOCAL=1
[[ "$DATABASE_TARGET" == *"127.0.0.1"* || "$DATABASE_TARGET" == *"localhost"* ]] && DB_IS_LOCAL=1

if [[ "$SUPABASE_IS_LOCAL" == "1" || "$DB_IS_LOCAL" == "1" ]]; then
  echo "[dev] Ensuring local Supabase is running..."
  if ! (cd "$SUPABASE_DIR" && supabase status >/dev/null 2>&1); then
    (cd "$SUPABASE_DIR" && supabase start)
  fi
else
  echo "[dev] Using configured cloud Supabase: $SUPABASE_TARGET"
fi

if [[ "$DB_IS_LOCAL" == "1" ]]; then
  echo "[dev] Waiting for Postgres on 127.0.0.1:54322..."
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

print("[dev] ERROR: Timed out waiting for Supabase Postgres on 127.0.0.1:54322", file=sys.stderr)
sys.exit(1)
PY
fi

ensure_agent_binary
ensure_dev_tunnel

echo "[dev] Starting frontend..."
pnpm --filter Kortix-Computer-Frontend dev &
FRONTEND_PID=$!

echo "[dev] Starting API..."
cd "$ROOT_DIR"
KORTIX_SKIP_ENSURE_SCHEMA=1 pnpm --filter kortix-api dev
