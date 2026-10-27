#!/usr/bin/env bash
# Refresh the vendored HyperFrames skills in skills/ (Kortix sessions only read skills/).
# Usage: scripts/sync-hyperframes-skills.sh [version]   — default: the version pipeline/package.json pins.
# Copies them from the HyperFrames repo at tag v<version>. Not `hyperframes skills update`: that
# always installs the latest published set, which no longer has five of these skills.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(node -p "require('$ROOT/pipeline/package.json').dependencies.hyperframes")}"
SKILLS=(hyperframes hyperframes-core hyperframes-animation hyperframes-keyframes hyperframes-cli
        hyperframes-audio hyperframes-creative hyperframes-registry)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -c advice.detachedHead=false clone -q --depth 1 --branch "v$VERSION" --filter=blob:none --sparse \
  https://github.com/heygen-com/hyperframes "$TMP/hf"
git -C "$TMP/hf" sparse-checkout set "${SKILLS[@]/#/skills/}"
for s in "${SKILLS[@]}"; do   # check all before replacing any
  [ -f "$TMP/hf/skills/$s/SKILL.md" ] || { echo "HyperFrames v$VERSION has no skills/$s" >&2; exit 1; }
done
for s in "${SKILLS[@]}"; do
  rm -rf "$ROOT/skills/$s"
  cp -r "$TMP/hf/skills/$s" "$ROOT/skills/$s"
done
echo "synced HyperFrames skills @ v$VERSION"
