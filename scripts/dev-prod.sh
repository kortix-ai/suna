#!/usr/bin/env bash
# Run API + Frontend locally against PRODUCTION database/services.
# Useful for debugging billing, account-state, and other prod-only flows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

API_ENV="$ROOT/apps/api/.env.prod"
WEB_ENV="$ROOT/apps/web/.env.prod"

[ -f "$API_ENV" ] || { echo "❌ Missing $API_ENV — see docs/development-release-guide.md"; exit 1; }
[ -f "$WEB_ENV" ] || { echo "❌ Missing $WEB_ENV — see docs/development-release-guide.md"; exit 1; }

echo ""
echo "  ⚠️  Running against PRODUCTION database"
echo "  API env:  $API_ENV"
echo "  Web env:  $WEB_ENV"
echo ""

cleanup() {
  # Restore the original web env-local override if it was backed up.
  [ -f "$ROOT/apps/web/.env.local.bak" ] && mv "$ROOT/apps/web/.env.local.bak" "$ROOT/apps/web/.env.local"
}

# Web isn't dotenvx-managed: copy its prod env into the gitignored override.
[ -f "$ROOT/apps/web/.env.local" ] && cp "$ROOT/apps/web/.env.local" "$ROOT/apps/web/.env.local.bak" 2>/dev/null || true
cp "$WEB_ENV" "$ROOT/apps/web/.env.local"

trap cleanup EXIT

# API: the prod profile (apps/api/.env.prod) is dotenvx-ENCRYPTED, so decrypt it
# in memory with `dotenvx run` (needs the _PROD key from apps/api/.env.keys or
# Dotenv Armor). Web reads its plaintext .env.local.
npx concurrently -n api,web -c cyan,magenta \
  "cd $ROOT/apps/api && $ROOT/node_modules/.bin/dotenvx run -f .env.prod -- bun run --watch src/index.ts" \
  "cd $ROOT/apps/web && pnpm dev"
