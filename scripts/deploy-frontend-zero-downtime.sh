#!/usr/bin/env bash
set -euo pipefail

# Zero-downtime deploy for the Kortix frontend image.
#
# Expected host setup:
# - repo checkout at ~/suna
# - runtime env file at apps/web/.env
# - nginx site config with a proxy_pass line, default:
#   /etc/nginx/sites-available/kortix-frontend
#
# Blue = 3000, green = 3001. The active slot is tracked in
# ~/.kortix-frontend-deploy-slot. On any failure before nginx verification, the
# current active slot is left untouched.

IMAGE_NAME="kortix-frontend"
STATE_FILE="$HOME/.kortix-frontend-deploy-slot"
NGINX_CONF="${KORTIX_FRONTEND_NGINX_CONF:-/etc/nginx/sites-available/kortix-frontend}"
HEALTH_PATH="${KORTIX_FRONTEND_HEALTH_PATH:-/api/runtime-config}"
HEALTH_TIMEOUT="${KORTIX_FRONTEND_HEALTH_TIMEOUT:-60}"
HEALTH_INTERVAL="${KORTIX_FRONTEND_HEALTH_INTERVAL:-2}"
LOCK_FILE="$HOME/.kortix-frontend-deploy.lock"
PREBUILT_IMAGE="${PREBUILT_IMAGE:-}"

cd ~/suna

exec 9>"$LOCK_FILE"
echo "[lock] Waiting for frontend deploy lock..."
flock 9
echo "[lock] Acquired frontend deploy lock"
trap 'flock -u 9 || true' EXIT

ACTIVE_SLOT="blue"
[ -f "$STATE_FILE" ] && ACTIVE_SLOT=$(cat "$STATE_FILE")

if [ "$ACTIVE_SLOT" = "blue" ]; then
  STANDBY_SLOT="green"
  ACTIVE_PORT=3000
  STANDBY_PORT=3001
else
  STANDBY_SLOT="blue"
  ACTIVE_PORT=3001
  STANDBY_PORT=3000
fi

echo "Frontend deploy: active=$ACTIVE_SLOT:$ACTIVE_PORT standby=$STANDBY_SLOT:$STANDBY_PORT"

echo "[1/6] Pulling latest code..."
git -c fetch.recurseSubmodules=false fetch origin main
git reset --hard origin/main

COMMIT=$(git rev-parse --short HEAD)
IMAGE_TAG="${IMAGE_NAME}:${COMMIT}"

if [ -n "$PREBUILT_IMAGE" ]; then
  echo "[2/6] Pulling prebuilt image $PREBUILT_IMAGE..."
  docker pull "$PREBUILT_IMAGE"
  IMAGE_TAG="$PREBUILT_IMAGE"
else
  echo "[2/6] Building ${IMAGE_TAG}..."
  (
    cd apps/web
    NEXT_PUBLIC_ENV_MODE=local \
    NEXT_PUBLIC_BACKEND_URL=http://localhost:8008/v1 \
    NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=local-build-placeholder-anon-key \
    NEXT_PUBLIC_BILLING_ENABLED=false \
    NEXT_OUTPUT=standalone \
    pnpm exec next build
  )
  docker build \
    --file apps/web/Dockerfile \
    --tag "$IMAGE_TAG" \
    --tag "${IMAGE_NAME}:latest" \
    .
fi

echo "[3/6] Starting $STANDBY_SLOT on port $STANDBY_PORT..."
docker rm -f "kortix-frontend-$STANDBY_SLOT" 2>/dev/null || true

ENV_ARGS=()
if [ -f apps/web/.env ]; then
  ENV_ARGS+=(--env-file apps/web/.env)
fi

docker run -d \
  --name "kortix-frontend-$STANDBY_SLOT" \
  "${ENV_ARGS[@]}" \
  -p "${STANDBY_PORT}:3000" \
  --restart unless-stopped \
  "$IMAGE_TAG"

echo "[4/6] Health checking $STANDBY_SLOT on port $STANDBY_PORT..."
ELAPSED=0
HEALTHY=false
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf "http://127.0.0.1:${STANDBY_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
    echo "  healthy after ${ELAPSED}s"
    HEALTHY=true
    break
  fi
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if [ "$HEALTHY" = "false" ]; then
  echo "  health check failed after ${HEALTH_TIMEOUT}s; leaving active slot untouched"
  docker logs "kortix-frontend-$STANDBY_SLOT" 2>&1 | tail -40 || true
  docker rm -f "kortix-frontend-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

echo "[5/6] Swapping nginx: $ACTIVE_PORT -> $STANDBY_PORT..."
if [ ! -f "$NGINX_CONF" ]; then
  echo "nginx config not found: $NGINX_CONF"
  docker rm -f "kortix-frontend-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${STANDBY_PORT};|" "$NGINX_CONF"

if sudo nginx -t 2>&1; then
  sudo nginx -s reload
  sleep 1
else
  echo "nginx config test failed; reverting"
  sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${ACTIVE_PORT};|" "$NGINX_CONF"
  docker rm -f "kortix-frontend-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

if curl -sf -k "https://127.0.0.1${HEALTH_PATH}" >/dev/null 2>&1; then
  echo "  nginx serving from $STANDBY_SLOT:$STANDBY_PORT"
else
  echo "nginx verification failed; reverting"
  sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${ACTIVE_PORT};|" "$NGINX_CONF"
  sudo nginx -s reload
  docker rm -f "kortix-frontend-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

echo "[6/6] Stopping old $ACTIVE_SLOT container..."
docker rm -f "kortix-frontend-$ACTIVE_SLOT" 2>/dev/null || true
echo "$STANDBY_SLOT" > "$STATE_FILE"
docker image prune -f --filter "until=1h" 2>/dev/null || true

echo "Frontend deploy complete: image=$IMAGE_TAG commit=$COMMIT active=$STANDBY_SLOT:$STANDBY_PORT"
