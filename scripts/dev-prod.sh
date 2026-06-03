#!/usr/bin/env bash
# Run API + Frontend locally against PRODUCTION database/services.
# Useful for debugging billing, account-state, and other prod-only flows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

API_ENV="$ROOT/apps/api/.env.prod"
WEB_ENV="$ROOT/apps/web/.env.prod"

[ -f "$API_ENV" ] || { echo "❌ Missing $API_ENV — create apps/api/.env.prod with production API credentials"; exit 1; }
[ -f "$WEB_ENV" ] || { echo "❌ Missing $WEB_ENV — create apps/web/.env.prod with production web credentials"; exit 1; }

echo ""
echo "  ⚠️  Running against PRODUCTION database"
echo "  API env:  $API_ENV"
echo "  Web env:  $WEB_ENV"
echo ""

# Copy prod env files into place (don't overwrite originals)
cp "$API_ENV" "$ROOT/apps/api/.env"
cp "$WEB_ENV" "$ROOT/apps/web/.env.local"

cleanup() {
  # Restore original env files if they were backed up
  [ -f "$ROOT/apps/api/.env.bak" ] && mv "$ROOT/apps/api/.env.bak" "$ROOT/apps/api/.env"
  [ -f "$ROOT/apps/web/.env.local.bak" ] && mv "$ROOT/apps/web/.env.local.bak" "$ROOT/apps/web/.env.local"
}

# Back up existing env files first
[ -f "$ROOT/apps/api/.env" ] && cp "$ROOT/apps/api/.env" "$ROOT/apps/api/.env.bak" 2>/dev/null || true
[ -f "$ROOT/apps/web/.env.local" ] && cp "$ROOT/apps/web/.env.local" "$ROOT/apps/web/.env.local.bak" 2>/dev/null || true

cp "$API_ENV" "$ROOT/apps/api/.env"
cp "$WEB_ENV" "$ROOT/apps/web/.env.local"

trap cleanup EXIT

# Run both in parallel
npx concurrently -n api,web -c cyan,magenta \
  "cd $ROOT/apps/api && bun run --watch src/index.ts" \
  "cd $ROOT/apps/web && pnpm dev"
