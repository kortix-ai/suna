#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

exec scripts/run_manual_named_recording.sh "${1:-5_other_keys}"
