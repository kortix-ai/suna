#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPABASE_DIR="$ROOT_DIR/supabase"

FRONTEND_PID=""
API_PID=""
TUNNEL_PID=""
TUNNEL_LOG=""
STRIPE_PID=""

# Build mode: `dev-local.sh --build` (a.k.a. `pnpm preview`) runs the EXACT same
# laptop diligence as `pnpm dev` — decrypt env, clear ports, Docker/Supabase,
# deps check, daemon/CLI rebuild, tunnel, Stripe — but serves a PRODUCTION build
# instead of the hot-reload dev servers: `next build` + `next start` for the web
# app and `bun run` (no --hot) for the API. Prod-accurate; heavier to iterate on.
BUILD_MODE=0
for _arg in "$@"; do
  case "$_arg" in
    --build) BUILD_MODE=1 ;;
  esac
done

load_local_env() {
  # pnpm --filter runs each package from its own directory, where Bun/Next may
  # auto-load package .env files. Be explicit here: use the app env files for
  # Supabase/auth (cloud dev has Google enabled), but force only the Kortix API
  # endpoint back to localhost and mark the process as local-dev so cloud
  # provision pollers do not sweep shared remote rows.
  # apps/api/.env and apps/web/.env are dotenvx-ENCRYPTED and committed to git.
  # Decrypt them with the dotenvx private keys — apps/{api,web}/.env.keys locally,
  # or Dotenv Armor (`dotenvx-armor login`) — and export into the shell so the
  # API (Bun) and web (Next) children inherit the plaintext values.
  local DOTENVX="$ROOT_DIR/node_modules/.bin/dotenvx" _f _env
  if [[ -x "$DOTENVX" ]]; then
    for _f in apps/api/.env apps/web/.env; do
      _env="$("$DOTENVX" get --format eval -f "$ROOT_DIR/$_f" 2>/dev/null || true)"
      if [[ -z "$_env" || "$_env" == *'="encrypted:'* ]]; then
        echo "[dev] ⚠️  could not decrypt $_f — run 'dotenvx-armor login' (or restore its .env.keys)" >&2
      else
        set -a; eval "$_env"; set +a
      fi
    done
  else
    echo "[dev] ⚠️  dotenvx not installed (run 'pnpm install') — env not loaded" >&2
  fi

  export KORTIX_LOCAL_DEV=1
  export ENV_MODE=local
  # `local_docker` was removed when we consolidated on cloud — listing it here
  # only made the API log "Unknown sandbox provider" twice on every boot.
  # Default only — the shared .env (decrypted above) or a personal .env.local
  # (below) decides the real provider order (e.g. "platinum,daytona").
  export ALLOWED_SANDBOX_PROVIDERS="${ALLOWED_SANDBOX_PROVIDERS:-daytona}"
  # KORTIX_URL is resolved by ensure_dev_tunnel() below. Cloud (Daytona)
  # sandboxes call BACK to it (LLM router, web search, RPC) and cannot reach
  # this machine's localhost — so they need a public tunnel URL. The dashboard
  # keeps talking to the API on localhost via NEXT_PUBLIC_BACKEND_URL, so only
  # the sandbox -> API direction goes through the tunnel.
  export NEXT_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export KORTIX_PUBLIC_BACKEND_URL="http://localhost:8008/v1"
  export BACKEND_URL="http://localhost:8008/v1"

  # Personal per-machine overrides — sourced LAST so they beat both the shared
  # encrypted env and the defaults above. Gitignored plaintext KEY=VALUE files
  # (no spaces in unquoted values). This is where billing-off, provider order,
  # DOCKER_HOST, etc. live for YOUR machine — never in the committed .env.
  for _f in apps/api/.env.local apps/web/.env.local; do
    if [[ -f "$ROOT_DIR/$_f" ]]; then
      set -a; source "$ROOT_DIR/$_f"; set +a
      echo "[dev] personal overrides loaded from $_f"
    fi
  done
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
  if [[ "${KORTIX_DEV_TUNNEL:-auto}" == "0" || ( "$default_provider" != "daytona" && "$default_provider" != "platinum" ) ]]; then
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
  TUNNEL_URL_FILE="${TUNNEL_URL_FILE:-$(mktemp -t kortix-tunnel-url.XXXXXX)}"
  printf '%s' "$url" > "$TUNNEL_URL_FILE"
  echo "[dev] ✅ Cloud sandbox callback ready: KORTIX_URL=$KORTIX_URL"
}

# Quick tunnels rot silently every few hours (the URL dies while cloudflared
# keeps running) — every death looks like "kortix is broken" until someone
# restarts the stack by hand. This watchdog probes the tunnel URL each minute;
# two consecutive failures WHILE the local API is healthy means the tunnel is
# dead: rotate cloudflared, write the fresh URL, and bounce the supervised API
# (its KORTIX_URL is baked at spawn). Sessions created on the old URL can't be
# saved (their baked env is gone with it) — but everything new just works.
start_tunnel_watchdog() {
  (
    while :; do
      sleep 60
      url="$(cat "$TUNNEL_URL_FILE" 2>/dev/null)" || continue
      curl -fsS -m 8 "$url/health" >/dev/null 2>&1 && continue
      # API itself down? Then it's not the tunnel — don't rotate.
      curl -fsS -m 2 "http://localhost:${PORT:-8008}/health" >/dev/null 2>&1 || continue
      sleep 5
      curl -fsS -m 8 "$url/health" >/dev/null 2>&1 && continue
      echo "[dev] ⚠️  tunnel $url is DEAD — rotating cloudflared + restarting API..."
      [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
      pkill -f 'cloudflared tunnel --no-autoupdate' 2>/dev/null || true
      TUNNEL_LOG="$(mktemp -t kortix-tunnel.XXXXXX)"
      cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT:-8008}" >"$TUNNEL_LOG" 2>&1 &
      TUNNEL_PID=$!
      newurl=""
      for i in $(seq 1 30); do
        newurl="$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1 || true)"
        [[ -n "$newurl" ]] && break
        sleep 1
      done
      if [[ -z "$newurl" ]]; then
        echo "[dev] ⚠️  tunnel rotation FAILED — will retry next minute"
        continue
      fi
      printf '%s' "$newurl" > "$TUNNEL_URL_FILE"
      touch "$TUNNEL_URL_FILE.rotated"
      echo "[dev] ✅ tunnel rotated: KORTIX_URL=$newurl (API restarting)"
      pkill -f 'bun run --hot src/index.ts' 2>/dev/null || true
    done
  ) &
  WATCHDOG_PID=$!
}

# Forward Stripe webhooks to the local API so billing flows (checkout →
# subscription → seat sync → credit grant) complete end-to-end instead of
# stalling after the hosted-checkout redirect. Runs in the background like the
# frontend; cleaned up on exit.
#
# Pinned to the API's own account via --api-key=$STRIPE_SECRET_KEY (already in
# the shell env from load_local_env), so the listener can never drift onto a
# different `stripe login` account than the API uses — the mismatch that makes
# events silently not fire. The signing secret stripe prints for that account
# must equal STRIPE_WEBHOOK_SECRET in apps/api/.env or the API rejects events.
#
# No-ops (with a hint) when the Stripe CLI is missing, billing is off, or no key
# is set. Opt out explicitly with KORTIX_STRIPE_LISTEN=0.
ensure_stripe_listen() {
  [[ "${KORTIX_STRIPE_LISTEN:-auto}" == "0" ]] && return 0
  [[ "${KORTIX_BILLING_INTERNAL_ENABLED:-}" == "true" ]] || return 0

  if ! command -v stripe >/dev/null 2>&1; then
    echo "[dev] ⚠️  stripe CLI not found — webhooks won't forward (brew install stripe-cli). Skipping."
    return 0
  fi
  if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
    echo "[dev] ⚠️  STRIPE_SECRET_KEY not set — skipping Stripe webhook listener."
    return 0
  fi

  local api_port="${PORT:-8008}"
  echo "[dev] Starting Stripe webhook listener → localhost:${api_port}/v1/billing/webhooks/stripe"
  stripe listen --api-key "$STRIPE_SECRET_KEY" \
    --forward-to "http://localhost:${api_port}/v1/billing/webhooks/stripe" 2>&1 \
    | sed 's/^/[stripe] /' &
  STRIPE_PID=$!
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

# Same idea for the `kortix` CLI binary the layered snapshot builder bakes into
# every sandbox (apps/cli/dist/kortix → KORTIX_SNAPSHOT_CLI_BIN_PATH). Without
# it, Daytona snapshot builds fail the required-artifact check.
ensure_cli_binary() {
  local dir="$ROOT_DIR/apps/cli"
  local bin="$dir/dist/kortix"

  if [[ -f "$bin" ]]; then
    local newer
    newer="$(find "$dir/src" "$dir/scripts" "$dir/package.json" \
      "$ROOT_DIR/packages/manifest-schema/src" "$ROOT_DIR/packages/starter/src" \
      -type f -newer "$bin" -print -quit 2>/dev/null || true)"
    if [[ -z "$newer" ]]; then
      echo "[dev] kortix CLI up to date — skipping CLI build"
      return 0
    fi
    echo "[dev] kortix CLI stale — rebuilding…"
  else
    echo "[dev] kortix CLI missing — building…"
  fi

  if (cd "$dir" && bun run build); then
    echo "[dev] ✅ kortix CLI (Linux x64) rebuilt — new snapshots will bake it"
  else
    echo "[dev] ⚠️  kortix CLI build failed — new snapshots may lack the CLI"
  fi
}

# Verify the workspace is actually LINKED, not just that node_modules/ exists.
# A partial tree — e.g. a sibling git worktree whose node_modules symlinks back
# into this checkout, so its own `pnpm/bun install` rewrites our symlink layer
# for a different branch's manifest — leaves node_modules/ present but `next` /
# `hono` unlinked and `.modules.yaml` gone. That surfaces ~10s later as the
# opaque "next: command not found" / "Cannot find package 'hono'". Check the
# exact things the dev servers need and reinstall if any are missing. A warm
# `pnpm install` is ~5s and idempotent, so this is cheap insurance; a failure
# aborts loudly instead of being swallowed into a half-broken boot.
ensure_deps() {
  if [[ -x "$ROOT_DIR/apps/web/node_modules/.bin/next" \
     && -d "$ROOT_DIR/apps/api/node_modules/hono" \
     && -f "$ROOT_DIR/node_modules/.modules.yaml" ]]; then
    return 0
  fi
  echo "[dev] Dependencies missing or partial — running pnpm install…"
  if ! (cd "$ROOT_DIR" && pnpm install); then
    echo "[dev] ❌ pnpm install failed — fix the error above and re-run 'pnpm dev'." >&2
    exit 1
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

  if [[ -n "${API_PID:-}" ]] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  fi

  if [[ -n "${TUNNEL_PID:-}" ]] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null || true
  fi

  if [[ -n "${WATCHDOG_PID:-}" ]] && kill -0 "$WATCHDOG_PID" 2>/dev/null; then
    kill "$WATCHDOG_PID" 2>/dev/null || true
  fi

  if [[ -n "${STRIPE_PID:-}" ]] && kill -0 "$STRIPE_PID" 2>/dev/null; then
    kill "$STRIPE_PID" 2>/dev/null || true
  fi
  [[ -n "${TUNNEL_LOG:-}" && -f "${TUNNEL_LOG:-}" ]] && rm -f "$TUNNEL_LOG"

  exit "$exit_code"
}

# ── Sandbox mode ───────────────────────────────────────────────────────────
# When `pnpm dev` runs INSIDE a Kortix sandbox (the runtime layer lives at
# /opt/kortix), bring the whole stack up self-contained — Supabase + API + web
# — and skip the laptop-only steps (cloudflared tunnel + daemon/CLI snapshot
# bake). The frontend is built once and served (`build` + `start`): `next dev`
# compiles every route on demand and OOMs on a big app, whereas build+start has
# a flat, light runtime and is prod-accurate. The agent just runs `pnpm dev`.
run_sandbox_dev() {
  echo "[dev] Kortix sandbox detected → full local stack (Supabase + API + web), self-contained."
  export PATH="/opt/supabase:/usr/local/bin:$PATH"
  export KORTIX_LOCAL_DEV=1 ENV_MODE=local

  # Docker daemon — Supabase runs as containers. Start it if boot didn't.
  if ! docker info >/dev/null 2>&1; then
    echo "[dev] starting dockerd…"
    (dockerd >/var/log/dockerd.log 2>&1 &)
    for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi

  # Local Supabase (Postgres + auth + REST + storage). Stop first for a clean
  # slate — a partial/leftover start holds ports (e.g. 54324) and makes the
  # next `supabase start` fail with "address already in use".
  if ! (cd "$SUPABASE_DIR" && supabase status >/dev/null 2>&1); then
    echo "[dev] supabase start…"
    (cd "$SUPABASE_DIR" && supabase stop --no-backup >/dev/null 2>&1 || true)
    (cd "$SUPABASE_DIR" && supabase start)
  fi
  # Deterministic local dev credentials from the running stack.
  eval "$(cd "$SUPABASE_DIR" && supabase status -o env 2>/dev/null | sed 's/^/export SB_/')"

  # Materialize the per-app env files. The local Supabase trio comes from the
  # running stack; infra/LLM secrets come from the project secrets the platform
  # injected into this sandbox's env (set them in the Kortix dashboard). Reserved
  # names (PORT/KORTIX_*) are never injected, so the runtime-local ones are set
  # explicitly here.
  #
  # NB: write to apps/api/.env.LOCAL, never apps/api/.env. The committed .env is
  # dotenvx-encrypted and tracked in git; a sandbox has no decryption key, and
  # overwriting the tracked file with plaintext would risk a secret leak via a
  # change request. .env.local is gitignored and Bun loads it at higher
  # precedence than .env (the API below starts with --env-file=.env.local).
  cat > "$ROOT_DIR/apps/api/.env.local" <<EOF
ENV_MODE=local
INTERNAL_KORTIX_ENV=dev
PORT=8008
KORTIX_URL=http://localhost:8008
KORTIX_SKIP_ENSURE_SCHEMA=1
ALLOWED_SANDBOX_PROVIDERS=daytona
DATABASE_URL=${SB_DB_URL}
SUPABASE_URL=${SB_API_URL}
SUPABASE_SERVICE_ROLE_KEY=${SB_SERVICE_ROLE_KEY}
DAYTONA_API_KEY=${DAYTONA_API_KEY:-}
DAYTONA_SERVER_URL=${DAYTONA_SERVER_URL:-}
DAYTONA_TARGET=${DAYTONA_TARGET:-us}
TUNNEL_SIGNING_SECRET=${TUNNEL_SIGNING_SECRET:-dev-local-tunnel-signing-secret-32chars}
API_KEY_SECRET=${API_KEY_SECRET:-dev-local-api-key-secret-please-32chars}
OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
SCHEDULER_ENABLED=false
EOF
  # NEXT_PUBLIC_BACKEND_URL is RELATIVE (/v1) so the browser hits the SAME
  # origin it's served from (whichever preview proxy — Daytona or Kortix
  # subdomain) and Next's built-in rewrite (next.config.ts: /v1/* ->
  # http://localhost:8008/v1/*) proxies it to the in-sandbox API. That makes a
  # single preview URL function as a full proxy (frontend + API), no CORS, no
  # exposed backend port, no token in client env. BACKEND_URL stays absolute for
  # server-side (SSR) fetches, which talk to the in-sandbox API directly.
  # Write to apps/web/.env.LOCAL (gitignored), never apps/web/.env — that file is
  # dotenvx-encrypted + tracked, and Next loads .env.local at higher precedence.
  # NEXT_PUBLIC_SUPABASE_URL is RELATIVE (/supabase) for the SAME reason as
  # NEXT_PUBLIC_BACKEND_URL above: the browser loads the app through the preview
  # proxy (a dynamic origin like p3000-<sandbox>.localhost:8008) and 127.0.0.1:54321
  # is the sandbox loopback — unreachable from the user's browser. So the browser
  # hits the SAME origin (/supabase) and next.config.ts's env-gated rewrite
  # (/supabase/* -> ${SB_API_URL}/*, active via KORTIX_SUPABASE_PROXY_TARGET below)
  # proxies it to the in-sandbox Supabase. SUPABASE_URL stays ABSOLUTE so the
  # server-side Supabase clients (supabase/server.ts, middleware.ts) reach
  # 127.0.0.1:54321 directly. Mirrors the /v1 BACKEND_URL split.
  cat > "$ROOT_DIR/apps/web/.env.local" <<EOF
NEXT_PUBLIC_BILLING_ENABLED=false
NEXT_PUBLIC_SUPABASE_URL=/supabase
SUPABASE_URL=${SB_API_URL}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SB_ANON_KEY}
NEXT_PUBLIC_BACKEND_URL=/v1
BACKEND_URL=http://localhost:8008/v1
NEXT_PUBLIC_APP_URL=http://localhost:3000
NEXT_PUBLIC_URL=http://localhost:3000
NEXT_PUBLIC_KORTIX_PERSONAL_CONTACT=false
EDGE_CONFIG=
EOF

  # Activate the same-origin Supabase proxy rewrite (next.config.ts). Env-gated
  # so it ONLY exists in the sandbox: forwards the browser's same-origin
  # /supabase/* to the in-sandbox Supabase. Exported (not just in .env.local) so
  # both `next dev` and `next build`/`next start` see it.
  export KORTIX_SUPABASE_PROXY_TARGET="${SB_API_URL}"

  # Export the SANDBOX-generated web env into THIS process so both the
  # production (build + start) and the dev (`next dev`) paths see the right
  # values: relative NEXT_PUBLIC_BACKEND_URL=/v1 and the in-sandbox Supabase
  # trio. For build+start, `next build` / `next start` (unlike the web's `dev`
  # npm script) do NOT run dotenvx, and Next does not reliably auto-load
  # apps/web/.env.local for the standalone/production server — so without
  # exporting, `next start` boots with NO BACKEND_URL / Supabase vars and every
  # SSR request 500s on the runtime-env Zod parse. Exporting makes NEXT_PUBLIC_*
  # inline at BUILD time and puts the server-only vars (BACKEND_URL, …) in
  # process.env for SSR. For the dev path we invoke `next dev` DIRECTLY (not the
  # web's `dev` script, which wraps `dotenvx run -f .env` and would inject the
  # committed laptop `localhost` values), so it relies on this same export.
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/apps/web/.env.local"
  set +a

  kill_dev_ports 3000 8008 "${PORT:-8008}"

  # A freshly-cloned session has no node_modules — install first. (Warm volumes
  # / a baked pnpm store make this near-instant later; cold it's a few minutes.)
  if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
    echo "[dev] Installing dependencies (pnpm install)…"
    (cd "$ROOT_DIR" && pnpm install) || echo "[dev] ⚠️  pnpm install reported issues — continuing"
  fi

  if [[ "$BUILD_MODE" == "1" ]]; then
    # `pnpm preview` → production parity: full build then `next start`.
    echo "[dev] Building frontend (pnpm build)…"
    if pnpm --filter Kortix-Computer-Frontend build; then
      echo "[dev] Frontend built — serving (pnpm start) on :3000"
      pnpm --filter Kortix-Computer-Frontend start &
      FRONTEND_PID=$!
    else
      echo "[dev] ⚠️  Frontend build failed — continuing with API only"
    fi
  else
    # `pnpm dev` → fast hot-reload via `next dev`. No heavy `next build`.
    # Invoke next DIRECTLY (not the web's `dev` npm script, which wraps
    # `dotenvx run -f .env` and would inject committed laptop `localhost`
    # values); the sandbox `.env.local` is already exported above (relative
    # NEXT_PUBLIC_BACKEND_URL=/v1, in-sandbox Supabase).
    echo "[dev] Starting frontend (next dev, hot reload) on :${WEB_PORT:-3000}"
    (cd "$ROOT_DIR/apps/web" && pnpm exec next dev --turbopack --port "${WEB_PORT:-3000}") &
    FRONTEND_PID=$!
  fi

  echo "[dev] Starting API (dev) on :8008"
  cd "$ROOT_DIR"
  # Sandbox mode reads the generated plaintext apps/api/.env.local (no dotenvx
  # decryption key here); dev:envfile starts Bun with --env-file=.env.local so
  # the encrypted, committed apps/api/.env is not auto-loaded.
  KORTIX_SKIP_ENSURE_SCHEMA=1 pnpm --filter kortix-api dev:envfile
}

trap cleanup EXIT INT TERM

if [[ -d /opt/kortix || -n "${KORTIX_SESSION_ID:-}" ]]; then
  run_sandbox_dev
  exit $?
fi

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

ensure_deps
ensure_agent_binary
ensure_cli_binary
ensure_dev_tunnel
ensure_stripe_listen

if [[ "$BUILD_MODE" == "1" ]]; then
  # The API needs no build step, so boot it in the BACKGROUND now and let it
  # come up on :8008 while the (multi-minute) frontend build runs — overlapping
  # the two instead of paying them back-to-back. cleanup() kills API_PID on exit.
  echo "[dev] Starting API (production runtime, no --hot) on :8008…"
  ( cd "$ROOT_DIR" && KORTIX_SKIP_ENSURE_SCHEMA=1 pnpm --filter kortix-api start ) &
  API_PID=$!


  # Production build of the web app on :3000. NEXT_PUBLIC_* values are inlined at
  # BUILD time, so the build must run with the env load_local_env() exported (it
  # has). KORTIX_PREVIEW_BUILD trims prod-only build work for speed — skips the
  # `standalone` file-tracing pass and ESLint (see apps/web/next.config.ts); it
  # never affects prod/CI/Vercel builds, which don't set it. `set -e` aborts here
  # if the build fails — we never serve a broken bundle.
  export KORTIX_PREVIEW_BUILD=1
  if [[ "${KORTIX_PREVIEW_TURBO:-1}" != "0" ]]; then
    # Turbopack: much faster than the webpack build (and the same engine `pnpm
    # dev` already uses). It can differ subtly from the webpack prod build, so
    # if a build issue ever bites, fall back with `KORTIX_PREVIEW_TURBO=0`.
    echo "[dev] Building frontend (next build --turbopack)…"
    pnpm --filter Kortix-Computer-Frontend exec next build --turbopack
  else
    echo "[dev] Building frontend (next build, webpack)…"
    pnpm --filter Kortix-Computer-Frontend build
  fi

  # Pin the web port explicitly. `next start` honors $PORT, and load_local_env
  # exports PORT=8008 from apps/api/.env — without --port the frontend would try
  # to bind 8008 and collide with the API (EADDRINUSE). This mirrors `pnpm dev`,
  # whose web command hardcodes `--port ${WEB_PORT:-3000}` for the same reason.
  echo "[dev] Build done → serving (next start, production) on :${WEB_PORT:-3000}…"
  cd "$ROOT_DIR"
  pnpm --filter Kortix-Computer-Frontend exec next start --port "${WEB_PORT:-3000}"
else
  echo "[dev] Starting frontend..."
  pnpm --filter Kortix-Computer-Frontend dev &
  FRONTEND_PID=$!

  start_tunnel_watchdog

  echo "[dev] Starting API (supervised — auto-restarts on tunnel rotation)..."
  cd "$ROOT_DIR"
  while :; do
    KORTIX_SKIP_ENSURE_SCHEMA=1 KORTIX_URL="$(cat "$TUNNEL_URL_FILE")" pnpm --filter kortix-api dev || true
    # Restart only when the watchdog rotated the tunnel; a plain exit (ctrl-C,
    # crash without rotation) leaves the loop so the script terminates normally.
    [[ -f "$TUNNEL_URL_FILE.rotated" ]] || break
    rm -f "$TUNNEL_URL_FILE.rotated"
    echo "[dev] ♻️  API restarting with rotated KORTIX_URL=$(cat "$TUNNEL_URL_FILE")"
  done
fi
