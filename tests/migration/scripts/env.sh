#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
export REPO_ROOT

export TESTS_DIR="${REPO_ROOT}/tests"
export MIGRATION_DIR="${TESTS_DIR}/migration"
export SUPABASE_MIGRATIONS_DIR="${REPO_ROOT}/supabase/migrations"

export COMPOSE_FILE="${TESTS_DIR}/docker-compose.test.yml"
export COMPOSE_SERVICE="postgres"

export TEST_DB_USER="${TEST_DB_USER:-kortix_test}"
export TEST_DB_PASSWORD="${TEST_DB_PASSWORD:-kortix_test}"
export TEST_DB_NAME="${TEST_DB_NAME:-kortix_test}"
export TEST_DB_PORT="${TEST_DB_PORT:-55432}"

export PG_IMAGE="postgres:16-alpine"

export RESULTS_DIR="${RESULTS_DIR:-${REPO_ROOT}/tests/test-results/migration}"

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

psql_exec() {
  compose exec -T \
    -e PGPASSWORD="${TEST_DB_PASSWORD}" \
    "${COMPOSE_SERVICE}" \
    psql -v ON_ERROR_STOP=1 -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" "$@"
}

psql_query() {
  psql_exec -tA -c "$1"
}

log() { printf '\033[0;36m[migration]\033[0m %s\n' "$*"; }
err() { printf '\033[0;31m[migration]\033[0m %s\n' "$*" >&2; }

assert_ephemeral_db() {
  case "${TEST_DB_NAME}" in
    *test*) ;;
    *)
      err "REFUSING: TEST_DB_NAME='${TEST_DB_NAME}' must contain 'test'."
      err "Migration/DB tests run ONLY against the ephemeral container in docker-compose.test.yml — never a real database."
      exit 1
      ;;
  esac
  if [ -n "${DATABASE_URL:-}" ] || [ -n "${SUPABASE_DB_URL:-}" ] || [ -n "${KE2E_DATABASE_URL:-}" ]; then
    err "NOTE: a real DB url is present in the environment but is IGNORED here — every statement runs inside the throwaway '${COMPOSE_SERVICE}' container only."
  fi
}
assert_ephemeral_db
