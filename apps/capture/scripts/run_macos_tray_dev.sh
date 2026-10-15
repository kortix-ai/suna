#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backend_dir="$(cd "$script_dir/.." && pwd)"
cd "$backend_dir"

usage() {
  cat <<'EOF'
Usage: scripts/run_macos_tray_dev.sh [--no-build] [--debug]

Builds and runs the unbundled Kortix tray binary from Terminal. This is the
preferred local macOS testing path because Accessibility/Input Monitoring
permissions can be granted once to Terminal/iTerm instead of being reset by
each ad-hoc app bundle rebuild.

Environment defaults for this dev runner:
  KORTIX_TRAY_AUTO_UPDATE=0
  KORTIX_TRAY_AUTO_LAUNCH=0
  KORTIX_TRAY_AUTO_START_RECORDING=1

You can override any of those before running the script.
EOF
}

build=1
profile=release

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build)
      build=0
      shift
      ;;
    --debug)
      profile=debug
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This dev runner is for macOS." >&2
  exit 1
fi

cargo_bin="${CARGO:-cargo}"
if ! "$cargo_bin" --version >/dev/null 2>&1; then
  echo "cargo is required. Install Rust first." >&2
  exit 1
fi

if [ "$build" -eq 1 ]; then
  cargo_args=(build --features native-recorders,tray-ui --bin kortix-backend --bin kortix-tray --bin kortix-capture)
  if [ "$profile" = "release" ]; then
    cargo_args+=(--release)
  fi
  echo "KORTIX_DEV_STEP build_backend_and_tray profile=$profile"
  "$cargo_bin" "${cargo_args[@]}"
fi

if [ "$profile" = "release" ]; then
  tray_bin="$backend_dir/target/release/kortix-tray"
else
  tray_bin="$backend_dir/target/debug/kortix-tray"
fi

if [ ! -x "$tray_bin" ]; then
  echo "Missing tray binary: $tray_bin" >&2
  echo "Run without --no-build first." >&2
  exit 1
fi

export KORTIX_TRAY_AUTO_UPDATE="${KORTIX_TRAY_AUTO_UPDATE:-0}"
export KORTIX_TRAY_AUTO_LAUNCH="${KORTIX_TRAY_AUTO_LAUNCH:-0}"
export KORTIX_TRAY_AUTO_START_RECORDING="${KORTIX_TRAY_AUTO_START_RECORDING:-1}"

cat <<EOF
KORTIX_DEV_STEP run_unbundled_tray
binary=$tray_bin

If macOS blocks recording, grant permissions to your launching terminal:
  System Settings > Privacy & Security > Accessibility
  System Settings > Privacy & Security > Input Monitoring
  System Settings > Privacy & Security > Screen Recording

Keep this terminal window open while testing. Press Ctrl-C to quit Kortix.
EOF

exec "$tray_bin"
