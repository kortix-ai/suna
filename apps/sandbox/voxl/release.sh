#!/usr/bin/env bash
# Build voxl for linux amd64 + arm64 and publish it as the GitHub release
# `voxl-<rev>-kortix.2` on kortix-ai/suna (rebranded web client, see Dockerfile). Then pin the printed values in
# packages/shared/src/runtime-versions.json (voxl, voxlSha256Amd64/Arm64).
# arm64 builds under QEMU on an x86 host (~30 min):
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
set -euo pipefail
rev="${1:?usage: release.sh <tembo/voxl commit sha>}"
out="$(mktemp -d)"
cd "$(dirname "$0")"
for arch in amd64 arm64; do
  docker buildx build --platform "linux/$arch" --build-arg VOXL_REV="$rev" \
    --build-context brand=../../web/public \
    --output "type=local,dest=$out/$arch" .
  gzip -9c "$out/$arch/out/bin/voxl" > "$out/voxl-linux-$arch.gz"
done
tag="voxl-${rev:0:12}-kortix.2"
gh release create "$tag" --repo kortix-ai/suna --prerelease --title "$tag" \
  --notes "voxl (github.com/tembo/voxl, MIT) at $rev, web client rebranded to Kortix Computer, 1 s stall cutoff, built by apps/sandbox/voxl/release.sh for the sandbox image." \
  "$out/voxl-linux-amd64.gz" "$out/voxl-linux-arm64.gz"
echo "\"voxl\": \"$rev\","
echo "\"voxlSha256Amd64\": \"$(sha256sum "$out/voxl-linux-amd64.gz" | cut -d' ' -f1)\","
echo "\"voxlSha256Arm64\": \"$(sha256sum "$out/voxl-linux-arm64.gz" | cut -d' ' -f1)\","
