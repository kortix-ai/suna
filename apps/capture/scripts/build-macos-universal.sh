#!/usr/bin/env bash
# Build universal macOS binaries into target/universal/:
#   kortix-capture          (Rust, arm64 + x86_64)
#   kortix-capture-engine   (Swift, arm64 + x86_64)
# The desktop supervisor expects both files side by side in `capture/`.
# Needs both Rust targets: rustup target add aarch64-apple-darwin x86_64-apple-darwin
set -euo pipefail
cd "$(dirname "$0")/.."
out=target/universal
mkdir -p "$out/tmp"

targets="aarch64-apple-darwin x86_64-apple-darwin"
for target in $targets; do
  if [ ! -d "$(rustc --print sysroot)/lib/rustlib/$target" ]; then
    echo "Rust target $target is not installed: rustup target add $target" >&2
    exit 1
  fi
done

for arch in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$arch-apple-macosx14.0" \
    native/macos/CaptureEngine.swift -o "$out/tmp/engine-$arch"
done

for target in $targets; do
  cargo build --release --bin kortix-capture --target "$target"
done

lipo -create -output "$out/kortix-capture" \
  target/aarch64-apple-darwin/release/kortix-capture target/x86_64-apple-darwin/release/kortix-capture
lipo -create -output "$out/kortix-capture-engine" "$out/tmp/engine-arm64" "$out/tmp/engine-x86_64"
rm -rf "$out/tmp"
for f in kortix-capture kortix-capture-engine; do lipo -archs "$out/$f"; done
