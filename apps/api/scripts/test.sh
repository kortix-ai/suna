#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-default}"

# Billing-enabled config requires the callback origin even when the test suite
# never boots the HTTP server. Local dev normally injects this from the tunnel;
# keep direct `pnpm --filter kortix-api test` runs deterministic as well.
export KORTIX_URL="${KORTIX_URL:-https://api.example.test}"

# Bun's mock.module registry is process-global. A large one-process invocation
# lets one test file's intentionally partial module double leak into every file
# loaded after it, producing order-dependent missing-export failures. Run each
# file in a fresh Bun process; this matches how an individual suite behaves and
# makes the package command deterministic regardless of filename ordering.
run_isolated() {
  local selector="$1"
  local failed=0
  local count=0
  # Keep coverage output absolute: a few black-box tests intentionally chdir
  # into disposable workspaces, and Bun resolves a relative --coverage-dir at
  # process shutdown after that chdir (which otherwise writes into a removed
  # temp directory and returns exit 1 despite every assertion passing).
  local coverage_root="$PWD/coverage-parts"

  if [ "${COVERAGE:-}" = "1" ]; then
    rm -rf coverage "$coverage_root"
    mkdir -p coverage "$coverage_root"
  fi

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    count=$((count + 1))
    echo "[api-test] $file"
    if [ "${COVERAGE:-}" = "1" ]; then
      if ! dotenvx run -- bun test --coverage --coverage-reporter=lcov \
        --coverage-dir="$coverage_root/$count" "$file"; then
        failed=1
      fi
    elif ! dotenvx run -- bun test "$file"; then
      failed=1
    fi
  done < <(eval "$selector")

  if [ "${COVERAGE:-}" = "1" ]; then
    # Multiple SF records are valid LCOV input; downstream consumers merge
    # duplicate source records while preserving coverage from every process.
    awk '1' "$coverage_root"/*/lcov.info > coverage/lcov.info
    rm -rf "$coverage_root"
  fi

  if [ "$failed" -ne 0 ]; then
    echo "[api-test] one or more isolated suites failed" >&2
    return 1
  fi
  echo "[api-test] $count isolated suites passed"
}

case "$mode" in
  integration)
    run_isolated "find src/__tests__ -name 'integration-*.test.ts' | sort"
    ;;
  live)
    exec env RUN_LIVE_LLM_TESTS=1 dotenvx run -- bun test src/llm-gateway/__tests__/gateway.live.test.ts
    ;;
  default)
    run_isolated "find src -name '*.test.ts' ! -name 'integration-*' ! -name '*.live.test.ts' | sort"
    ;;
  *)
    echo "usage: test.sh [default|integration|live]" >&2
    exit 2
    ;;
esac
