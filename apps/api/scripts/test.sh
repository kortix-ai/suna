#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-default}"

case "$mode" in
  integration)
    # Real-PostgreSQL suites (`integration-*.test.ts`, `*.integration.test.ts`)
    # run in the `db-suites` lane of the root runner: one process and one fresh
    # migrated database per file, on local Supabase. Extra arguments are path
    # filters, e.g. `pnpm --filter kortix-api test:integration prompt-inbox`.
    shift
    if [ "$#" -eq 0 ]; then set -- apps/api/; fi
    # --no-env-file: apps/api/.env is dotenvx ciphertext; the lane needs none of it.
    exec bun --no-env-file ../../tests/bin/db-suites.ts "$@"
    ;;
  live)
    exec env RUN_LIVE_LLM_TESTS=1 dotenvx run -- bun test --isolate src/llm-gateway/__tests__/gateway.live.test.ts
    ;;
  default)
    # Real-PostgreSQL suites run in `integration` mode (the root `db-suites`
    # lane), never here: without a database they could only skip.
    files=$(find src -name '*.test.ts' ! -name 'integration-*' ! -name '*.integration.test.ts' ! -name '*.live.test.ts' | sort)
    count=$(printf '%s\n' "$files" | grep -c . || true)
    # A suite that runs nothing must never exit 0. `bun test` with an empty
    # file list happily reports success, so a broken find/rename here would
    # turn the whole gate green while testing nothing. Floor it.
    if [ "$count" -lt "${KORTIX_MIN_TEST_FILES:-400}" ]; then
      echo "error: only $count test files matched (floor ${KORTIX_MIN_TEST_FILES:-400}) — the discovery glob is broken, refusing to report success." >&2
      exit 1
    fi
    coverage_dir=""
    if [ "${COVERAGE:-}" = "1" ]; then
      mkdir -p coverage
      coverage_dir="$(mktemp -d coverage/.batches.XXXXXX)"
    fi
    test_timeout="${KORTIX_TEST_TIMEOUT_MS:-15000}"
    source scripts/test-workers.sh
    api_test_workers="${KORTIX_API_TEST_WORKERS:-$(detect_api_test_workers)}"
    case "$api_test_workers" in
      ''|*[!0-9]*|0)
        echo "error: KORTIX_API_TEST_WORKERS must be a positive integer" >&2
        exit 2
        ;;
    esac
    # --env-file=scripts/test.env, NOT dotenvx: the unit suite is hermetic. It runs
    # off a committed plaintext file of fake values, so it behaves identically
    # on a laptop with no decryption key and on a CI runner that must never be
    # handed one. `--env-file` also stops bun auto-loading the encrypted .env,
    # which would otherwise inject `encrypted:…` ciphertext as var values.
    # Real credentials belong to `live` above, which is not part of this gate.
    #
    # --isolate: bunfig.toml's `[test] isolation = true` documents the intent
    # (each test file gets a fresh global object, so mock.module() in one billing/
    # sandbox-proxy/etc. unit test can't leak into another's real, unmocked
    # module) but that config key isn't honored by this bun version's CLI —
    # the flag is required explicitly. Without it, cross-file mock.module()
    # collisions are order-dependent and can silently pass or fail depending
    # on which files happen to run adjacently.
    #
    # Four workers are safe on a 32 GiB CI runner. A 12 GiB agent sandbox needs
    # two: four workers exhausted it during a detached 924-file suite. Explicit
    # KORTIX_API_TEST_WORKERS remains available for known dedicated runners.
    # Bun retains memory across isolated files inside each worker process. A
    # single-worker run reached 8.9 GiB RSS before the final files. Restart
    # workers after each bounded batch, and run every batch even if one fails.
    test_files=()
    while IFS= read -r file; do test_files+=("$file"); done <<< "$files"
    batch_size=80
    batch_count=$(( (count + batch_size - 1) / batch_size ))
    echo "API unit suite: $count files in $batch_count batches; Bun workers: $api_test_workers" >&2
    failed=0
    for ((offset=0; offset<count; offset+=batch_size)); do
      batch=("${test_files[@]:offset:batch_size}")
      batch_number=$((offset / batch_size + 1))
      echo "API unit batch $batch_number/$batch_count: ${#batch[@]} files" >&2
      coverage_args=()
      if [[ -n "$coverage_dir" ]]; then
        coverage_args=(--coverage --coverage-reporter=lcov --coverage-reporter=text --coverage-dir="$coverage_dir/$batch_number")
      fi
      if bun test --isolate --parallel="$api_test_workers" --env-file=scripts/test.env --timeout="$test_timeout" "${coverage_args[@]}" "${batch[@]}"; then
        :
      else
        failed=1
      fi
    done
    if [[ -n "$coverage_dir" ]]; then
      # LCOV is a stream of SF...end_of_record entries. Keep every batch's
      # entries in the public report instead of overwriting it on each run.
      : > coverage/lcov.info
      reports=0
      for report in "$coverage_dir"/*/lcov.info; do
        if [[ -f "$report" ]]; then
          cat "$report" >> coverage/lcov.info
          reports=$((reports + 1))
        fi
      done
      if (( reports != batch_count )); then
        echo "error: coverage reports found for $reports/$batch_count API unit batches" >&2
        failed=1
      fi
    fi
    exit "$failed"
    ;;
  *)
    echo "usage: test.sh [default|integration|live]" >&2
    exit 2
    ;;
esac
