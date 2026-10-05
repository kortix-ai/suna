#!/usr/bin/env bash
#
# Build every release target. Used at release time (deploy-dev.yml /
# deploy-prod.yml build these with the same bun flags).
set -euo pipefail
HERE="$(dirname "${BASH_SOURCE[0]}")"
echo "Building all kortix-tui release targets…"
bash "$HERE/bundle-darwin-arm64.sh"
bash "$HERE/bundle-darwin-x64.sh"
bash "$HERE/bundle-linux-x64.sh"
bash "$HERE/bundle-linux-arm64.sh"
echo
echo "Done. Binaries in apps/tui/bundle/."
