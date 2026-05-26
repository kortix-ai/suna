#!/usr/bin/env bash
# Build apps/sandbox/Dockerfile, publish it to a registry the Platinum
# control plane can pull from, then register/refresh the Platinum template
# Kortix points at via PLATINUM_TEMPLATE.
#
# Why this exists:
#   Every Platinum sandbox boots from an ext4 rootfs built from a Docker
#   image. Platinum's `template-from-docker.sh` injects our PID-1 init
#   (`dnah-init`) over the image — that init now mounts /tmp as tmpfs so a
#   leaking guest service (bun PTY mmap, opencode SQLite WAL, browser
#   cache, etc.) can't fill the fixed-size rootfs and wedge the whole
#   sandbox. The fix only takes effect on the NEXT template build. This
#   script triggers that rebuild end-to-end.
#
# Usage:
#   PLATINUM_API_KEY=…  scripts/sync-platinum-template.sh
#   PLATINUM_API_KEY=…  TAG=kortix-computer scripts/sync-platinum-template.sh
#   PLATINUM_API_KEY=…  REGISTRY=ghcr.io/kortix-ai PUSH=1 scripts/sync-platinum-template.sh
#
# Env:
#   PLATINUM_API_KEY  required — admin / org key with template:write
#   PLATINUM_API_URL  default https://api.platinum.dev
#   TAG               default "kortix-computer" (the template name registered
#                     on Platinum; PLATINUM_TEMPLATE in apps/api .env points here)
#   IMAGE             default "kortix/sandbox:tmpfs-$(git rev-parse --short HEAD)"
#                     — the docker tag we build + push
#   REGISTRY          default kortix on Docker Hub. Override for ghcr/ECR.
#   PUSH              default 1. Set PUSH=0 to skip the docker push (e.g.
#                     when you've prebuilt + pushed elsewhere).
#   SIZE_MB           default 8192 — rootfs filesystem size. Must be ≥ the
#                     image's natural size + headroom for /workspace state.
#                     The kortix/sandbox image is ~3 GiB; 8 GiB leaves
#                     5 GiB for the user's repo + opencode state.
#
# After this runs successfully, Kortix users get the new template on their
# next sandbox spawn — no client-side change required as long as the
# PLATINUM_TEMPLATE env var in apps/api still points at TAG (default
# "kortix-computer").

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

API_URL="${PLATINUM_API_URL:-https://api.platinum.dev}"
API_KEY="${PLATINUM_API_KEY:?PLATINUM_API_KEY required (admin or org key)}"
TAG="${TAG:-kortix-computer}"
REGISTRY="${REGISTRY:-kortix}"
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo dev)"
IMAGE="${IMAGE:-${REGISTRY}/sandbox:tmpfs-${SHA}}"
PUSH="${PUSH:-1}"
SIZE_MB="${SIZE_MB:-8192}"

log() { printf "\033[36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[32m✓ %s\033[0m\n" "$*"; }

# 1) Build the sandbox image. The Dockerfile is the lean Kortix base —
#    bun:1-debian + opencode-ai + git + kortix-agent. /tmp ends up on the
#    rootfs by default; Platinum's dnah-init then remounts it as tmpfs at
#    VM boot. No image-side change needed.
log "building $IMAGE from apps/sandbox/Dockerfile"
docker build --platform linux/amd64 \
  -f apps/sandbox/Dockerfile \
  -t "$IMAGE" \
  .

# 2) Push so Platinum's build host can `podman pull` it. Skippable if
#    you've prebuilt + pushed via CI.
if [ "$PUSH" = "1" ]; then
  log "pushing $IMAGE"
  docker push "$IMAGE"
  ok "pushed $IMAGE"
fi

# 3) Tell Platinum to build a fresh template from the image. The CP runs
#    template-from-docker.sh on a build host (idempotent — running it
#    again with the same TAG creates a new template id and deprecates the
#    prior one of the same name). Returns 202 + the new template id.
log "registering template '$TAG' on Platinum from $IMAGE (size=${SIZE_MB} MiB)"
RESP=$(curl -fsS -X POST "$API_URL/v1/templates/from-image" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<EOF
{
  "name": "$TAG",
  "image": "$IMAGE",
  "size_mb": $SIZE_MB,
  "default_cpu": 4,
  "default_ram_mb": 8192,
  "default_disk_gb": 4
}
EOF
)")
TPL_ID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$TPL_ID" ] || { echo "register failed: $RESP"; exit 2; }
ok "template build queued: $TPL_ID (state=building)"

# 4) Poll until ready. Platinum reports state via GET /v1/templates.
#    template-from-docker.sh takes ~2-5 min for a 3 GiB image (apt + tar +
#    mkfs.ext4) + ~30 s for chunked-CAS upload.
log "polling template state (every 10 s, deadline 15 min)"
DEADLINE=$(( $(date +%s) + 900 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(curl -fsS "$API_URL/v1/templates" -H "Authorization: Bearer $API_KEY" 2>/dev/null \
    | python3 -c "import json,sys; rows=json.load(sys.stdin); rows=rows.get('rows',rows) if isinstance(rows,dict) else rows; m=[t for t in rows if t.get('id')=='$TPL_ID']; print(m[0]['state'] if m else 'missing')" 2>/dev/null || echo "?")
  printf "  state=%s\n" "$STATE"
  case "$STATE" in
    ready) ok "template $TPL_ID is READY"; break ;;
    failed) echo "FAILED — inspect /internal/admin/templates.json for build_logs"; exit 3 ;;
  esac
  sleep 10
done
[ "$STATE" = "ready" ] || { echo "timed out waiting for ready"; exit 4; }

cat <<EOF

────────────────────────────────────────────────────────────────────
Done. Kortix sandboxes that resolve their template via
PLATINUM_TEMPLATE=$TAG will now boot from $TPL_ID, which has /tmp on
tmpfs (size=50% RAM) — so guest-side leaks can't wedge the rootfs.

If apps/api/.env doesn't already point there:
  echo 'PLATINUM_TEMPLATE=$TAG' >> apps/api/.env
  systemctl restart kortix-api

Existing sandboxes are still on the prior template; they pick up the
new bits on next spawn.
────────────────────────────────────────────────────────────────────
EOF
