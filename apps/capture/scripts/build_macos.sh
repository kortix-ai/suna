#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

cargo_bin="${CARGO:-cargo}"
rustup_bin="${RUSTUP:-rustup}"
target="${MACOS_RUST_TARGET:-}"

if command -v cargo >/dev/null 2>&1; then
  cargo_bin="${CARGO:-cargo}"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  cargo_bin="${CARGO:-$HOME/.cargo/bin/cargo}"
fi

if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first." >&2
  exit 1
fi

if ! command -v "$rustup_bin" >/dev/null 2>&1 && [ -x "$HOME/.cargo/bin/rustup" ]; then
  rustup_bin="$HOME/.cargo/bin/rustup"
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script builds native macOS recorder binaries and should run on macOS." >&2
  echo "Use GitHub Actions macos-latest or a local macOS machine." >&2
  exit 1
fi

cargo_args=(build --release --features native-recorders,tray-ui)
binary_dir="target/release"

if [ -n "$target" ]; then
  if ! "$rustup_bin" --version >/dev/null 2>&1; then
    echo "rustup is required to manage Rust targets." >&2
    exit 1
  fi
  if ! "$rustup_bin" target list --installed | grep -qx "$target"; then
    echo "BUILD_STEP rustup_target_add $target"
    "$rustup_bin" target add "$target"
  fi
  cargo_args+=(--target "$target")
  binary_dir="target/$target/release"
fi

echo "BUILD_STEP macos_release ${target:-host}"
"$cargo_bin" "${cargo_args[@]}" \
  --bin kortix-backend \
  --bin kortix-process-raw \
  --bin kortix-compare-processors \
  --bin kortix-tray \
  --bin kortix-capture

privacy_arch=arm64
if [ "${target:-$(uname -m)}" = "x86_64" ] || [[ "${target:-}" == x86_64-* ]]; then privacy_arch=x86_64; fi
python3 "$script_dir/install_privacy_runtime.py" --platform "macos-$privacy_arch" --destination "$binary_dir"

echo "BUILD_OK $binary_dir"
ls -lh \
  "$binary_dir/kortix-backend" \
  "$binary_dir/kortix-process-raw" \
  "$binary_dir/kortix-compare-processors" \
  "$binary_dir/kortix-tray" \
  "$binary_dir/kortix-capture"

echo "MACOS_RUNTIME_PERMISSIONS Screen Recording, Accessibility, and Input Monitoring are required for real native capture."
