#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."

target="${WINDOWS_RUST_TARGET:-x86_64-pc-windows-gnu}"
cargo_bin="${CARGO:-cargo}"
rustup_bin="${RUSTUP:-rustup}"

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

if ! "$rustup_bin" --version >/dev/null 2>&1; then
  echo "rustup is required to manage Rust targets." >&2
  exit 1
fi

if ! "$rustup_bin" target list --installed | grep -qx "$target"; then
  echo "BUILD_STEP rustup_target_add $target"
  "$rustup_bin" target add "$target"
fi

if [ "$target" = "x86_64-pc-windows-gnu" ] && ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  echo "Missing x86_64-w64-mingw32-gcc." >&2
  echo "On Ubuntu/Debian, install it with: sudo apt-get update && sudo apt-get install -y mingw-w64" >&2
  exit 1
fi

# One combined app: action recording, screen memory, and its native engine.
bin_args=(--bin kortix-backend --bin kortix-process-raw --bin kortix-compare-processors --bin kortix-tray --bin kortix-capture --bin kortix-capture-engine)
out_bins=(kortix-backend.exe kortix-process-raw.exe kortix-compare-processors.exe kortix-tray.exe kortix-capture.exe kortix-capture-engine.exe)

echo "BUILD_STEP windows_release $target"
"$cargo_bin" build --release --target "$target" --features native-recorders,tray-ui \
  "${bin_args[@]}"

binary_dir="target/$target/release"
python3 "$script_dir/install_privacy_runtime.py" --platform windows-x86_64 --destination "$binary_dir"

echo "BUILD_OK $binary_dir"
for bin in "${out_bins[@]}"; do ls -lh "$binary_dir/$bin"; done
