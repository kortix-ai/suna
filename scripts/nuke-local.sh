#!/usr/bin/env bash
set -euo pipefail

# ─── Kortix Local Dev — Full Nuke & Reset ────────────────────────────────────
#
# Destroys ALL local state and starts fresh:
#   1. Kills local dev processes bound to common ports
#   2. Removes repo Docker containers (compose + sandbox + local Supabase)
#   3. Removes repo Docker volumes (sandbox + local Supabase data)
#   4. Clears the Supabase local stack state
#   5. Optionally restarts dev (API + frontend)
#
# Usage:
#   pnpm nuke              # nuke everything
#   pnpm nuke:start        # nuke everything, then start dev
# ─────────────────────────────────────────────────────────────────────────────

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPABASE_DIR="$ROOT_DIR/supabase"
SUPABASE_PROJECT_ID="$(python3 - "$SUPABASE_DIR/config.toml" <<'PY'
import pathlib, re
import sys
text = pathlib.Path(sys.argv[1]).read_text()
match = re.search(r'^project_id\s*=\s*"([^"]+)"', text, re.MULTILINE)
print(match.group(1) if match else 'kortix-local')
PY
)"

START_DEV=false
if [[ "${1:-}" == "--start" ]]; then
  START_DEV=true
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NUKING LOCAL DEV ENVIRONMENT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Kill local dev processes ────────────────────────────────────────────────
echo "[1/5] Killing running processes..."
lsof -ti:8008 2>/dev/null | xargs -r kill -9 2>/dev/null || true
lsof -ti:3000 2>/dev/null | xargs -r kill -9 2>/dev/null || true
echo "  done (ports 8008, 3000 cleared)"

DOCKER_AVAILABLE=true
if ! docker info >/dev/null 2>&1; then
  DOCKER_AVAILABLE=false
fi

# ── 2. Remove repo containers ─────────────────────────────────────────────────
echo "[2/5] Removing repo Docker containers..."
if ! $DOCKER_AVAILABLE; then
  echo "  WARNING: Docker daemon unavailable — repo containers not removed"
else
  CONTAINERS=$(docker ps -a --format "{{.Names}}" | grep -E "^kortix-|^kortix-sandbox$|^supabase_.*_${SUPABASE_PROJECT_ID}$" || true)
  if [[ -n "$CONTAINERS" ]]; then
    printf '%s\n' "$CONTAINERS" | xargs docker rm -f >/dev/null 2>&1 || true
    echo "  removed: $(printf '%s ' "$CONTAINERS")"
  else
    echo "  (no repo containers)"
  fi
fi

# ── 3. Remove repo volumes ────────────────────────────────────────────────────
echo "[3/5] Removing repo Docker volumes..."
if ! $DOCKER_AVAILABLE; then
  echo "  WARNING: Docker daemon unavailable — repo volumes not removed"
else
  VOLS=$(docker volume ls --format "{{.Name}}" | grep -E "sandbox|^kortix_supabase-db-data$|^supabase_(db|storage)_" || true)
  if [[ -n "$VOLS" ]]; then
    printf '%s\n' "$VOLS" | xargs docker volume rm -f >/dev/null 2>&1 || true
    echo "  removed: $(printf '%s ' "$VOLS")"
  else
    echo "  (no volumes)"
  fi
fi

# ── 4. Verify sandbox image exists ──────────────────────────────────────────
echo "[4/5] Checking sandbox image..."
cd "$ROOT_DIR"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-kortix/kortix-sandbox:dev}"

if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
  echo "  $SANDBOX_IMAGE exists locally"
else
  echo "  WARNING: $SANDBOX_IMAGE not found locally!"
  echo "  Build it first:  docker build -f apps/sandbox/Dockerfile -t $SANDBOX_IMAGE ."
  echo "  Or the API will try to pull it from Docker Hub on first init."
fi

# ── 5. Clear Supabase local state ─────────────────────────────────────────────
echo "[5/5] Clearing Supabase local state..."
cd "$SUPABASE_DIR"
if ! $DOCKER_AVAILABLE; then
  echo "  WARNING: Docker daemon unavailable — Supabase local state not cleared"
elif supabase stop --no-backup >/dev/null 2>&1; then
  echo "  done (stack stopped, local data cleared)"
else
  echo "  done (nothing running or already cleared)"
fi
cd "$ROOT_DIR"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  NUKED. Image: $SANDBOX_IMAGE"
echo "  Next: pnpm dev (starts API + frontend, sandbox auto-creates on first request)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Optional: restart dev ─────────────────────────────────────────────────────
if $START_DEV; then
  echo "Starting dev (API + frontend)..."
  cd "$ROOT_DIR"
  exec pnpm run dev
fi
