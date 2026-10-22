#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

stress_events="${STRESS_EVENTS:-75000}"
stress_iterations="${STRESS_ITERATIONS:-1}"
stress_max_rss_mib="${STRESS_MAX_RSS_MIB:-180}"
stress_max_rss_growth_mib="${STRESS_MAX_RSS_GROWTH_MIB:-24}"
stress_min_events_per_cpu_second="${STRESS_MIN_EVENTS_PER_CPU_SECOND:-5000}"

cargo_bin="${CARGO:-cargo}"
python_bin="${PYTHON:-python3}"

if command -v cargo >/dev/null 2>&1; then
  cargo_bin="${CARGO:-cargo}"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  cargo_bin="${CARGO:-$HOME/.cargo/bin/cargo}"
fi

echo "VERIFY_STEP cargo_fmt"
"$cargo_bin" fmt --check

echo "VERIFY_STEP cargo_check"
"$cargo_bin" check --all-targets

echo "VERIFY_STEP cargo_check_native_recorders"
"$cargo_bin" check --all-targets --features native-recorders

echo "VERIFY_STEP cargo_test"
"$cargo_bin" test

echo "VERIFY_STEP screenshot_sync_self_test"
"$python_bin" scripts/test_compare_screenshot_sync.py

echo "VERIFY_STEP trace_compare_self_test"
"$python_bin" scripts/test_compare_trace_artifacts.py

echo "VERIFY_OK"
