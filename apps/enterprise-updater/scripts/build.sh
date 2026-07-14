#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mkdir -p dist

target="${BUN_COMPILE_TARGET:-bun-linux-x64}"
bun build \
  --compile \
  --minify \
  --target="$target" \
  --outfile=dist/kortix-enterprise-updater \
  src/main.ts

chmod 0755 dist/kortix-enterprise-updater
