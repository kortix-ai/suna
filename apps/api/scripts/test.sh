#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-default}"

case "$mode" in
  integration)
    exec dotenvx run -- bun test --isolate src/__tests__/integration-*.test.ts
    ;;
  live)
    exec env RUN_LIVE_LLM_TESTS=1 dotenvx run -- bun test --isolate src/llm-gateway/__tests__/gateway.live.test.ts
    ;;
  default)
    files=$(find src -name '*.test.ts' ! -name 'integration-*' ! -name '*.live.test.ts' | sort)
    cov=""
    if [ "${COVERAGE:-}" = "1" ]; then
      cov="--coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=coverage"
    fi
    # --isolate: bunfig.toml's `[test] isolation = true` documents the intent
    # (each test file in its own process, so mock.module() in one billing/
    # sandbox-proxy/etc. unit test can't leak into another's real, unmocked
    # module) but that config key isn't honored by this bun version's CLI —
    # the flag is required explicitly. Without it, cross-file mock.module()
    # collisions are order-dependent and can silently pass or fail depending
    # on which files happen to run adjacently.
    exec dotenvx run -- bun test --isolate $cov $files
    ;;
  *)
    echo "usage: test.sh [default|integration|live]" >&2
    exit 2
    ;;
esac
