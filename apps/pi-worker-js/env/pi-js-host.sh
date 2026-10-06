#!/usr/bin/env bash
# THE pi-js BRANCH ENVIRONMENT, ON ONE COMMIT. Runs ON the environment's VM.
#
#   pi-js-host.sh upgrade <full sha>   new images + migrations, data kept
#   pi-js-host.sh fresh   <full sha>   new instance, new database, new images
#
# The environment is the Platinum DEV microVM `kortix-env-pi-worker-js`; its
# port 8080 is https://pi-js.kortix.com (infra/cloudflare/workers/pi-js-router).
# It runs the self-hosted stack of the pi-worker-js branch, and its sessions run
# as pi cells on Platinum dev. Launch it with ./pi-js-deploy.mjs, not by hand.
#
# The steps are the CI preview host script's (tests/src/core/sandbox-preview.ts)
# with four differences, each one measured on this environment 2026-10-06:
#   - sessions provision on Platinum DEV (the only Platinum that runs cells);
#   - KORTIX_PI_CELL_ENABLED and the cell template/worker are set;
#   - internal billing is off: the environment has no live Stripe key, and the
#     API refuses to boot with billing on and no Stripe;
#   - the managed provider is on: the default models are Kortix-managed and go
#     through OPENROUTER_API_KEY; off, every turn fails model_disabled_on_deployment.
# Secrets come from $STATE/runtime-secrets.json on the VM; nothing here holds one.
set -euo pipefail
MODE="${1:?upgrade|fresh}"
SHA="${2:?full sha}"
case "$MODE" in upgrade|fresh) ;; *) echo "mode must be upgrade or fresh" >&2; exit 2 ;; esac
ROOT=/workspace/suna
STATE=/workspace/kortix-preview
INST=$STATE/self-host/pr-7117
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG=$STATE/pi-js.log
PHASE=$STATE/pi-js.phase
STATUS=$STATE/pi-js.exit
rm -f "$STATUS"
# As the CI host script: the self-host CLI writes its instance under this dir,
# and CI=1 keeps pnpm from stopping at a prompt it then "answers" with exit 0.
export HOME=/root CI=1 KORTIX_SELF_HOST_CONFIG_DIR="$STATE/self-host" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$ROOT/tests/test-results"
exec >>"$LOG" 2>&1
trap 'code=$?; echo "$code" > "$STATUS"' EXIT
phase() { echo "$1" > "$PHASE"; echo "== $(date -u +%T) $MODE $SHA: $1"; }
compose() {
  docker compose --project-name kortix-pr-7117 --env-file "$INST/.env" \
    -f "$INST/docker-compose.yml" -f "$STATE/docker-compose.preview.yml" "$@"
}
set_env() {
  if grep -q "^$1=" "$INST/.env"; then sed -i "s|^$1=.*|$1=$2|" "$INST/.env"; else printf '%s=%s\n' "$1" "$2" >> "$INST/.env"; fi
}

if [ "$MODE" = upgrade ]; then
  phase backup
  BK=$STATE/backup-$STAMP
  mkdir -p "$BK"
  cp -p "$INST/.env" "$INST/docker-compose.yml" "$STATE/docker-compose.preview.yml" "$STATE/Caddyfile.preview" "$BK/"
  docker exec kortix-pr-7117-supabase-db-1 pg_dump -U postgres -d postgres -Fc > "$BK/postgres.dump"
  test -s "$BK/postgres.dump"
fi

phase checkout
git -C "$ROOT" fetch --depth=1 origin pi-worker-js
git -C "$ROOT" checkout --detach --force FETCH_HEAD
git -C "$ROOT" clean -ffd
test "$(git -C "$ROOT" rev-parse HEAD)" = "$SHA"

phase toolchain
if [ "$(node --version)" != "v22.22.2" ]; then
  node_archive=/tmp/node-v22.22.2-linux-x64.tar.xz
  curl -fsSL https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz -o "$node_archive"
  printf '%s  %s\n' '88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a' "$node_archive" | sha256sum -c -
  tar -xJf "$node_archive" -C /usr/local --strip-components=1
  rm -f "$node_archive"
fi
corepack enable
cd "$ROOT"
pnpm install --offline --frozen-lockfile || pnpm install --frozen-lockfile
test -e packages/registry/node_modules/@kortix/manifest-schema

if [ "$MODE" = fresh ]; then
  phase teardown
  if [ -f "$INST/.env" ]; then compose down -v --remove-orphans --timeout 30; fi
  # Moved aside, not deleted: the old database files stay on disk until removed by hand.
  if [ -d "$INST" ]; then mv "$INST" "$STATE/retired-pr-7117-$STAMP"; fi
  docker image prune -af
  docker builder prune -af || true
fi

phase configure
bun apps/cli/src/index.ts self-host init --yes --local-images --no-restrict-account-creation --instance pr-7117
PREVIEW_INSTANCE_DIR="$INST" PREVIEW_STATE_DIR="$STATE" PREVIEW_ORIGIN=https://pi-js.kortix.com \
  PREVIEW_SHA="$SHA" PREVIEW_SECRETS_FILE="$STATE/runtime-secrets.json" \
  PLATINUM_API_URL=https://api-dev.platinum.dev PREVIEW_INSTANCE_ID=kortix-env-pi-worker-js \
  bun tests/bin/preview-stack.ts
set_env KORTIX_PI_CELL_ENABLED true
set_env KORTIX_PI_CELL_TEMPLATE pt-celld
set_env KORTIX_PI_CELL_WORKER kortix-pi-cell
set_env KORTIX_BILLING_INTERNAL_ENABLED false
set_env KORTIX_PUBLIC_BILLING_ENABLED false
set_env KORTIX_MANAGED_PROVIDER_ENABLED true

phase pull
df -h / | tail -1
used="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "${used:-0}" -ge 80 ]; then docker image prune -af || true; fi
for attempt in 1 2 3; do
  compose pull --policy missing && break
  [ "$attempt" -lt 3 ] || exit 1
  sleep $((attempt * 60))
done

phase up
# A fresh database races Supabase storage: kortix-migrate can reach the
# branding-bucket migration after storage-api created storage.buckets but
# before it granted INSERT to postgres ("permission denied for table
# buckets"). The grants land seconds later, so one retry clears it.
up_ok=
for attempt in 1 2; do
  if compose up -d --wait --wait-timeout 600; then up_ok=1; break; fi
  echo "::kortix-migrate output (attempt $attempt)"; compose logs --no-color --tail 40 kortix-migrate || true
  echo "::kortix-api output (attempt $attempt)"; compose logs --no-color --tail 120 kortix-api || true
  sleep 15
done
if [ -z "$up_ok" ]; then
  compose ps -a || true
  if [ "$MODE" = upgrade ]; then
    echo "!! upgrade failed; restoring $BK (the database stays migrated)"
    cp -p "$BK/.env" "$INST/.env"
    cp -p "$BK/docker-compose.yml" "$INST/docker-compose.yml"
    cp -p "$BK/docker-compose.preview.yml" "$STATE/docker-compose.preview.yml"
    cp -p "$BK/Caddyfile.preview" "$STATE/Caddyfile.preview"
    compose up -d --wait --wait-timeout 300 || true
  fi
  exit 1
fi

phase verify
health=
for i in $(seq 1 30); do
  health="$(curl -sf http://127.0.0.1:8080/v1/health)" && break
  sleep 2
done
echo "$health"
echo "$health" | grep -q "\"commit\":\"$SHA\""
compose ps --format '{{.Name}} {{.Image}} {{.Status}}'
phase done
