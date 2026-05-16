#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [ -n "${BUN_COMPILE_TARGET:-}" ]; then
  target="$BUN_COMPILE_TARGET"
else
  case "$(uname -m)" in
    x86_64|amd64) target="bun-linux-x64" ;;
    arm64|aarch64) target="bun-linux-arm64" ;;
    *)
      echo "Unsupported build architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
fi

case "$target" in
  bun-linux-x64|bun-linux-arm64) ;;
  *)
    echo "Unsupported Bun compile target: $target" >&2
    exit 1
    ;;
esac

bun build --compile --target="$target" --outfile=dist/kortix-agent src/main.ts
chmod +x dist/kortix-agent
size="$(stat -f%z dist/kortix-agent 2>/dev/null || stat -c%s dist/kortix-agent)"
echo "Built dist/kortix-agent for ${target} (${size} bytes)"
