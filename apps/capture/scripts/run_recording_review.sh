#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

name="${1:-review}"
export MANUAL_RECORDING_OUTPUT_ROOT="${MANUAL_RECORDING_OUTPUT_ROOT:-artifacts/recording-review}"

exec scripts/run_manual_named_recording.sh "$name"
