#!/usr/bin/env bash
script_dir="$(cd "$(dirname "$0")" && pwd)"
exec "$script_dir/run_macos_tray_dev.sh" "$@"
