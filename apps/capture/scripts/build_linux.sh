#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

cargo_bin="${CARGO:-cargo}"
rustup_bin="${RUSTUP:-rustup}"
target="${LINUX_RUST_TARGET:-}"

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

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "This script builds native Linux recorder binaries and should run on Linux." >&2
    echo "Use GitHub Actions ubuntu-latest or a local Linux machine." >&2
    exit 1
    ;;
esac

missing=()
for lib in xi xtst x11 xrandr xcb; do
  if ! pkg-config --exists "$lib"; then
    missing+=("$lib")
  fi
done
if ! ldconfig -p 2>/dev/null | grep -q 'libxdo\.so' && \
  ! find /usr/lib /usr/local/lib -name 'libxdo.so*' -print -quit 2>/dev/null | grep -q .; then
  missing+=("libxdo.so")
fi
if ! pkg-config --exists gtk+-3.0; then
  missing+=("gtk+-3.0")
fi
if ! pkg-config --exists ayatana-appindicator3-0.1 && ! pkg-config --exists appindicator3-0.1; then
  missing+=("ayatana-appindicator3-0.1 or appindicator3-0.1")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing native recorder/tray system libraries: ${missing[*]}" >&2
  echo "On Ubuntu/Debian, install them with:" >&2
  echo "sudo apt-get update && sudo apt-get install -y build-essential pkg-config libxi-dev libxtst-dev libx11-dev libxrandr-dev libxcb1-dev libxdo-dev libgtk-3-dev libayatana-appindicator3-dev" >&2
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

# One combined app: action recording, screen memory, and its native engine.
bin_args=(--bin kortix-backend --bin kortix-process-raw --bin kortix-compare-processors --bin kortix-tray --bin kortix-capture --bin kortix-capture-engine)
out_bins=(kortix-backend kortix-process-raw kortix-compare-processors kortix-tray kortix-capture kortix-capture-engine)

echo "BUILD_STEP linux_release ${target:-host}"
"$cargo_bin" "${cargo_args[@]}" \
  "${bin_args[@]}"

echo "BUILD_OK $binary_dir"
for bin in "${out_bins[@]}"; do ls -lh "$binary_dir/$bin"; done
