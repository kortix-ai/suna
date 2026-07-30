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
    count=$(printf '%s\n' "$files" | grep -c . || true)
    # A suite that runs nothing must never exit 0. `bun test` with an empty
    # file list happily reports success, so a broken find/rename here would
    # turn the whole gate green while testing nothing. Floor it.
    if [ "$count" -lt "${KORTIX_MIN_TEST_FILES:-400}" ]; then
      echo "error: only $count test files matched (floor ${KORTIX_MIN_TEST_FILES:-400}) — the discovery glob is broken, refusing to report success." >&2
      exit 1
    fi
    cov=""
    if [ "${COVERAGE:-}" = "1" ]; then
      cov="--coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir=coverage"
    fi
    # --env-file=scripts/test.env, NOT dotenvx: the unit suite is hermetic. It runs
    # off a committed plaintext file of fake values, so it behaves identically
    # on a laptop with no decryption key and on a CI runner that must never be
    # handed one. `--env-file` also stops bun auto-loading the encrypted .env,
    # which would otherwise inject `encrypted:…` ciphertext as var values.
    # Real credentials belong to `integration` and `live` above, which are not
    # part of this gate.
    #
    # --isolate: bunfig.toml's `[test] isolation = true` documents the intent
    # (each test file in its own process, so mock.module() in one billing/
    # sandbox-proxy/etc. unit test can't leak into another's real, unmocked
    # module) but that config key isn't honored by this bun version's CLI —
    # the flag is required explicitly. Without it, cross-file mock.module()
    # collisions are order-dependent and can silently pass or fail depending
    # on which files happen to run adjacently.
    exec bun test --isolate --env-file=scripts/test.env $cov $files
    ;;
  *)
    echo "usage: test.sh [default|integration|live]" >&2
    exit 2
    ;;
esac
