#!/usr/bin/env bash
set -euo pipefail

# ─── Zero-Downtime Deploy for Kortix API ─────────────────────────────────────
#
# Blue/green deployment using nginx as the traffic switcher:
#
#   1. Pull latest code (old container still serving)
#   2. Build new image with explicit tag (old container still serving)
#   3. Start new container on standby port
#   4. Health check the new container
#   5. Swap nginx upstream → reload (graceful, no dropped connections)
#   6. Stop old container
#   7. On failure at any step: automatic rollback
#
# Port allocation: Blue = 8008, Green = 8009
# State file: ~/.kortix-deploy-slot tracks which slot is active
# ─────────────────────────────────────────────────────────────────────────────

IMAGE_NAME="kortix-api"
STATE_FILE="$HOME/.kortix-deploy-slot"
NGINX_CONF="/etc/nginx/sites-available/kortix-api"
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=2
LOCK_FILE="$HOME/.kortix-deploy.lock"
PREBUILT_IMAGE="${PREBUILT_IMAGE:-}"

cd ~/suna

# ── Serialize deploys on-host (defense in depth) ────────────────────────────
exec 9>"$LOCK_FILE"
echo "[lock] Waiting for deploy lock..."
flock 9
echo "[lock] Acquired deploy lock"
trap 'flock -u 9 || true' EXIT

# ── Resolve active/standby slots ─────────────────────────────────────────────
ACTIVE_SLOT="blue"
[ -f "$STATE_FILE" ] && ACTIVE_SLOT=$(cat "$STATE_FILE")

if [ "$ACTIVE_SLOT" = "blue" ]; then
  STANDBY_SLOT="green"
  ACTIVE_PORT=8008
  STANDBY_PORT=8009
else
  STANDBY_SLOT="blue"
  ACTIVE_PORT=8009
  STANDBY_PORT=8008
fi

echo "┌─────────────────────────────────────────┐"
echo "│ Zero-Downtime Deploy                    │"
echo "│ Active: $ACTIVE_SLOT (port $ACTIVE_PORT)               │"
echo "│ Deploy: $STANDBY_SLOT (port $STANDBY_PORT)               │"
echo "└─────────────────────────────────────────┘"

# ── 1. Pull latest code ──────────────────────────────────────────────────────
echo "[1/6] Pulling latest code..."
git -c fetch.recurseSubmodules=false fetch origin main
git reset --hard origin/main
git submodule sync --recursive
git submodule update --init --recursive --remote

# Migrate .env from old paths to new paths (one-time after repo restructure)
[ -f kortix-api/.env ] && [ ! -f apps/api/.env ] && mkdir -p apps/api && mv kortix-api/.env apps/api/.env && echo "  Migrated kortix-api/.env → apps/api/.env"
[ -f apps/frontend/.env ] && [ ! -f apps/web/.env ] && mkdir -p apps/web && mv apps/frontend/.env apps/web/.env && echo "  Migrated apps/frontend/.env → apps/web/.env"

COMMIT=$(git rev-parse --short HEAD)
IMAGE_TAG="${IMAGE_NAME}:${COMMIT}"

# ── 2. Prepare image ─────────────────────────────────────────────────────────
if [ -n "$PREBUILT_IMAGE" ]; then
  echo "[2/6] Pulling prebuilt image $PREBUILT_IMAGE..."
  docker pull "$PREBUILT_IMAGE"
  IMAGE_TAG="$PREBUILT_IMAGE"
else
  echo "[2/6] Building ${IMAGE_TAG} (traffic still on $ACTIVE_SLOT:$ACTIVE_PORT)..."
  docker build \
    --file apps/api/Dockerfile \
    --build-arg SERVICE=apps/api \
    --tag "$IMAGE_TAG" \
    --tag "${IMAGE_NAME}:latest" \
    --no-cache \
    .
fi

# ── 3. Start standby container ───────────────────────────────────────────────
echo "[3/6] Starting $STANDBY_SLOT on port $STANDBY_PORT..."
docker rm -f "kortix-api-$STANDBY_SLOT" 2>/dev/null || true

# Extract version from image tag (e.g. "kortix/kortix-api:0.8.29" → "0.8.29")
# Falls back to git commit short SHA for dev builds
SANDBOX_VERSION="${IMAGE_TAG##*:}"
echo "  SANDBOX_VERSION=$SANDBOX_VERSION"

docker run -d \
  --name "kortix-api-$STANDBY_SLOT" \
  --env-file apps/api/.env \
  -e "SANDBOX_VERSION=$SANDBOX_VERSION" \
  -p "${STANDBY_PORT}:8008" \
  --restart unless-stopped \
  "$IMAGE_TAG"

# ── 4. Health check standby ──────────────────────────────────────────────────
echo "[4/6] Health checking $STANDBY_SLOT on port $STANDBY_PORT..."
ELAPSED=0
HEALTHY=false
while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT" ]; do
  if curl -sf "http://127.0.0.1:${STANDBY_PORT}/v1/health" > /dev/null 2>&1; then
    echo "  ✓ Healthy after ${ELAPSED}s"
    HEALTHY=true
    break
  fi
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if [ "$HEALTHY" = "false" ]; then
  echo "  ✗ Health check FAILED after ${HEALTH_TIMEOUT}s — rolling back"
  echo "  Container logs:"
  docker logs "kortix-api-$STANDBY_SLOT" 2>&1 | tail -20
  docker rm -f "kortix-api-$STANDBY_SLOT" 2>/dev/null || true
  echo "  Rollback complete. Active ($ACTIVE_SLOT:$ACTIVE_PORT) unchanged."
  exit 1
fi

# ── 5. Swap nginx to standby port ────────────────────────────────────────────
echo "[5/6] Swapping nginx: $ACTIVE_PORT → $STANDBY_PORT..."
sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${STANDBY_PORT};|" "$NGINX_CONF"

if sudo nginx -t 2>&1; then
  sudo nginx -s reload
  sleep 1
else
  echo "  ✗ nginx config test failed — reverting"
  sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${ACTIVE_PORT};|" "$NGINX_CONF"
  docker rm -f "kortix-api-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

# Verify nginx is serving from the new port
if curl -sf -k "https://127.0.0.1/v1/health" > /dev/null 2>&1; then
  echo "  ✓ nginx serving from $STANDBY_SLOT:$STANDBY_PORT"
else
  echo "  ✗ nginx verification failed — reverting"
  sudo sed -i "s|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${ACTIVE_PORT};|" "$NGINX_CONF"
  sudo nginx -s reload
  docker rm -f "kortix-api-$STANDBY_SLOT" 2>/dev/null || true
  exit 1
fi

# ── 6. Stop old container + cleanup ──────────────────────────────────────────
echo "[6/6] Stopping old $ACTIVE_SLOT container..."
docker rm -f "kortix-api-$ACTIVE_SLOT" 2>/dev/null || true

# Save new active slot
echo "$STANDBY_SLOT" > "$STATE_FILE"

# Prune old images (keep current + previous for fast rollback)
docker image prune -f --filter "until=1h" 2>/dev/null || true

echo ""
echo "┌─────────────────────────────────────────┐"
echo "│ ✓ Deploy complete — zero downtime       │"
echo "│ Active: $STANDBY_SLOT (port $STANDBY_PORT)               │"
echo "│ Image:  $IMAGE_TAG"
echo "│ Commit: $COMMIT                         │"
echo "└─────────────────────────────────────────┘"
