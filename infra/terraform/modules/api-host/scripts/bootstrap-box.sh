#!/usr/bin/env bash
# Provision a fresh (or rebuilt) Kortix API box from zero to deploy-ready.
#
# Idempotent: safe to re-run. Installs Docker + nginx, lays down the canonical
# nginx site and Docker daemon DNS config, clones the repo, and prepares the
# blue/green deploy slots so the normal CI deploy (deploy-zero-downtime.sh) can
# take over. Run as a sudo-capable user (e.g. `ubuntu`) on the box:
#
#   curl -fsSL <raw-url>/bootstrap-box.sh | bash      # or scp + bash
#
# After this, set ~/suna/apps/api/.env and let CI deploy, or run the deploy
# script manually.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/kortix-ai/suna.git}"
REPO_DIR="${REPO_DIR:-$HOME/suna}"
BRANCH="${BRANCH:-main}"
HERE="$(cd "$(dirname "$0")" && pwd)"
FILES_DIR="$(cd "$HERE/../files" && pwd)"

echo "==> 1/6 apt deps"
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl gnupg git nginx jq

echo "==> 2/6 Docker (official repo)"
if ! command -v docker >/dev/null 2>&1; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
sudo usermod -aG docker "$USER" || true

echo "==> 3/6 Docker daemon DNS (containers can't resolve on some Lightsail nets)"
sudo install -m 0644 "$FILES_DIR/docker-daemon.json" /etc/docker/daemon.json
sudo systemctl enable --now docker
sudo systemctl restart docker

echo "==> 4/6 nginx site (blue/green 8008/8009, ws upgrade map)"
sudo install -m 0644 "$FILES_DIR/nginx-kortix-api.conf" /etc/nginx/sites-available/kortix-api
sudo ln -sf /etc/nginx/sites-available/kortix-api /etc/nginx/sites-enabled/kortix-api
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

echo "==> 5/6 repo at $REPO_DIR ($BRANCH)"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch origin "$BRANCH" --depth=1
  git -C "$REPO_DIR" checkout "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

echo "==> 6/6 deploy slot marker (active = 8008)"
echo 8008 | sudo tee /etc/kortix-api-active-port >/dev/null

cat <<'NEXT'

Bootstrap complete. Remaining manual steps:
  1. Write   ~/suna/apps/api/.env   (dev secrets — never commit it)
  2. Trigger a deploy (push to main with AUTO_DEPLOY_DEV=true, or run
     scripts/deploy-zero-downtime.sh on the box).
  3. Point dev-api.kortix.com at this box's static IP (managed by the
     cloudflare-dns Terraform module).
NEXT
