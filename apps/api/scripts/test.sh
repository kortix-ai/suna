#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-default}"

case "$mode" in
  integration)
    # Discovered with the same recursive `find` as `default` (which excludes
    # exactly this set). A flat glob on src/__tests__ silently dropped
    # integration tests that live next to the code they cover, so they ran in
    # neither bucket.
    files=$(find src -name 'integration-*.test.ts' | sort)
    exec dotenvx run -- bun test $files
    ;;
  live)
    exec env RUN_LIVE_LLM_TESTS=1 dotenvx run -- bun test src/llm-gateway/__tests__/gateway.live.test.ts
    ;;
  default)
    files=$(find src -name '*.test.ts' ! -name 'integration-*' ! -name '*.live.test.ts' | sort)
    cov=""
    if [ "${COVERAGE:-}" = "1" ]; then
      cov="--coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=coverage"
    fi
    exec dotenvx run -- bun test $cov $files
    ;;
  *)
    echo "usage: test.sh [default|integration|live]" >&2
    exit 2
    ;;
esac
