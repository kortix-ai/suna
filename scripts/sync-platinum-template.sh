#!/usr/bin/env bash
# Trigger Platinum to rebuild a template from a PUBLIC docker image.
#
# This does NOT build or push a docker image. The image is whatever it is
# (kortix-computer, kortix/sandbox, your custom image, etc.) — Platinum
# pulls it server-side via podman, wraps it with our PID-1 init
# (`dnah-init`) and produces a fresh template ext4 rootfs.
#
# The deep fix this is the rollout vehicle for: `dnah-init` now mounts /tmp
# as tmpfs at VM boot. That bounds the blast radius of any guest-side leak
# (bun PTY mmap files, opencode SQLite WAL, browser caches, …) — a leaking
# service eventually ENOSPC's its own tmpfs and fails, while the rootfs
# (and /workspace) stay healthy. The fix only takes effect on the NEXT
# template build; this script triggers that build.
#
# Prereqs (operator runs these in the platinum-dev repo BEFORE this script):
#   infra/deploy-bundle.sh daytonah-cp   # CP updated
#   infra/deploy-hosts.sh                # build hosts updated
#
# Usage:
#   PLATINUM_API_KEY=<admin-token> \
#     IMAGE=kortix/sandbox:latest \
#     scripts/sync-platinum-template.sh
#
#   # with custom name + size:
#   PLATINUM_API_KEY=…  IMAGE=…  NAME=kortix-computer  SIZE_MB=8192 \
#     scripts/sync-platinum-template.sh
#
# Env:
#   PLATINUM_API_KEY  required — admin key (or org key with template:write)
#   IMAGE             required — fully-qualified PUBLIC docker image
#                                (e.g. kortix/sandbox:latest,
#                                docker.io/kortix/computer:v1,
#                                ghcr.io/kortix-ai/sandbox:main).
#                                Platinum's build host pulls this via podman.
#   NAME              default "kortix-computer". Platinum's PLATINUM_TEMPLATE
#                     resolves by name, so keeping the same name swaps the
#                     ready template in place on next sandbox spawn.
#   SIZE_MB           default 8192 — rootfs ext4 size. Must be ≥ the image's
#                     natural size + headroom for /workspace state.
#   PLATINUM_API_URL  default https://api.platinum.dev

set -euo pipefail

API_URL="${PLATINUM_API_URL:-https://api.platinum.dev}"
API_KEY="${PLATINUM_API_KEY:?PLATINUM_API_KEY required (admin or org key)}"
IMAGE="${IMAGE:?IMAGE required (e.g. IMAGE=kortix/sandbox:latest)}"
NAME="${NAME:-kortix-computer}"
SIZE_MB="${SIZE_MB:-8192}"

log() { printf "\033[36m▶ %s\033[0m\n" "$*"; }
ok()  { printf "\033[32m✓ %s\033[0m\n" "$*"; }

# Sanity: Platinum is reachable and the key is valid.
log "verifying Platinum credentials"
curl -fsS "$API_URL/v1/templates" -H "Authorization: Bearer $API_KEY" >/dev/null \
  || { echo "auth failed: cannot GET /v1/templates with the provided key"; exit 1; }
ok "Platinum reachable"

# Queue the build. Platinum's CP inserts a templates row at state='building'
# and queues a host_command for the build host. Idempotent on NAME — a
# successful build creates a NEW template id and deprecates the prior
# 'ready' row of the same name, so PLATINUM_TEMPLATE pointing at NAME
# transparently cuts over to the new one on next spawn.
log "registering template '$NAME' from $IMAGE (size=${SIZE_MB} MiB)"
RESP=$(curl -fsS -X POST "$API_URL/v1/templates/from-image" \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<EOF
{
  "name": "$NAME",
  "image": "$IMAGE",
  "size_mb": $SIZE_MB,
  "default_cpu": 4,
  "default_ram_mb": 8192,
  "default_disk_gb": 4
}
EOF
)")
TPL_ID=$(printf '%s' "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
[ -n "$TPL_ID" ] || { echo "register failed: $RESP"; exit 2; }
ok "build queued: $TPL_ID (state=building)"

# Poll. template-from-docker.sh runs on a build host — it podman-pulls the
# image, extracts, injects dnah-init (with /tmp tmpfs), builds ext4,
# uploads chunked CAS. Typical: 2-8 min depending on image size and host
# load. Cap the wait at 20 min so a stuck build doesn't trap the script.
log "polling state every 10 s (deadline 20 min)"
DEADLINE=$(( $(date +%s) + 1200 ))
STATE="?"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  STATE=$(curl -fsS "$API_URL/v1/templates" -H "Authorization: Bearer $API_KEY" 2>/dev/null \
    | python3 -c "import json,sys; rows=json.load(sys.stdin); rows=rows.get('rows',rows) if isinstance(rows,dict) else rows; m=[t for t in rows if t.get('id')=='$TPL_ID']; print(m[0]['state'] if m else 'missing')" 2>/dev/null || echo "?")
  printf "  state=%s\n" "$STATE"
  case "$STATE" in
    ready)  ok "$TPL_ID ready"; break ;;
    failed) echo "BUILD FAILED — inspect GET /v1/templates/$TPL_ID for build_logs"; exit 3 ;;
  esac
  sleep 10
done
[ "$STATE" = "ready" ] || { echo "timed out at state=$STATE"; exit 4; }

cat <<EOF

────────────────────────────────────────────────────────────────────
Done. Kortix sandboxes spawning with PLATINUM_TEMPLATE=$NAME will now
boot from the rebuilt template $TPL_ID, with /tmp on tmpfs (50% RAM).

Existing running sandboxes are still on the prior template; they pick
up the new bits on next spawn.
────────────────────────────────────────────────────────────────────
EOF
