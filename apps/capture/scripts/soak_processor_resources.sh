#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

python_bin="${PYTHON:-python3}"
cargo_bin="${CARGO:-cargo}"
events="${SOAK_EVENTS:-100000}"
iterations="${SOAK_ITERATIONS:-20}"
max_rss_mib="${SOAK_MAX_RSS_MIB:-180}"
max_rss_growth_mib="${SOAK_MAX_RSS_GROWTH_MIB:-24}"
min_events_per_cpu_second="${SOAK_MIN_EVENTS_PER_CPU_SECOND:-5000}"
summary_json="${SOAK_SUMMARY_JSON:-artifacts/resource-soak/processor-soak-summary.json}"

if command -v cargo >/dev/null 2>&1; then
  cargo_bin="${CARGO:-cargo}"
elif [ -x "$HOME/.cargo/bin/cargo" ]; then
  cargo_bin="${CARGO:-$HOME/.cargo/bin/cargo}"
fi

"$cargo_bin" build --release --bin kortix-process-raw

"$python_bin" scripts/stress_processor_resources.py \
  --skip-build \
  --events "$events" \
  --iterations "$iterations" \
  --max-rss-mib "$max_rss_mib" \
  --max-rss-growth-mib "$max_rss_growth_mib" \
  --min-events-per-cpu-second "$min_events_per_cpu_second" \
  --summary-json "$summary_json"
