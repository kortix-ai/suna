#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "${runtime_dir}/dist"
(
  cd "${runtime_dir}"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -buildvcs=false \
    -trimpath \
    -ldflags='-s -w' \
    -o "${runtime_dir}/dist/kortix-appd-linux-amd64" \
    .
)

# Keep Caddy and its security overrides in a checked-in module. Provider build
# contexts consume this exact staged binary.
(
  cd "${runtime_dir}/caddy"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -buildvcs=false \
    -trimpath \
    -ldflags='-s -w' \
    -o "${runtime_dir}/dist/caddy-linux-amd64" \
    .
)
