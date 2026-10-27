#!/usr/bin/env bash
# Refresh the vendored HyperFrames skills in skills/ (Kortix sessions only read skills/).
# Usage: scripts/sync-hyperframes-skills.sh [version]   — keep in step with pipeline/package.json.
set -euo pipefail
VERSION="${1:-0.8.151}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && HOME="$TMP" npx -y "hyperframes@$VERSION" skills update >/dev/null )
for s in hyperframes hyperframes-core hyperframes-animation hyperframes-keyframes hyperframes-cli \
         hyperframes-audio hyperframes-creative hyperframes-registry; do
  rm -rf "$ROOT/skills/$s"
  cp -r "$TMP/.agents/skills/$s" "$ROOT/skills/$s"
done
echo "synced HyperFrames skills @ $VERSION"
