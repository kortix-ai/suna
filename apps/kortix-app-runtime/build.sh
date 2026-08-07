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

# Keep the ingress binary reproducible. The Go checksum database verifies the
# module contents. Provider build contexts consume this exact staged binary.
CADDY_VERSION="v2.11.4"
build_gopath="$(mktemp -d)"
trap 'rm -rf "${build_gopath}"' EXIT
GOMODCACHE="$(go env GOMODCACHE)" GOPATH="${build_gopath}" \
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go install -ldflags='-s -w' "github.com/caddyserver/caddy/v2/cmd/caddy@${CADDY_VERSION}"
mv "${build_gopath}/bin/linux_amd64/caddy" "${runtime_dir}/dist/caddy-linux-amd64"
