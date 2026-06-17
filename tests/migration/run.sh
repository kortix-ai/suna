#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/scripts/env.sh"

# Orchestrates the full migration test run:
#   1. start throwaway Postgres
#   2. apply supabase/migrations in order
#   3. seed fixtures
#   4. run schema / idempotency / rollback test suites
#   5. emit JUnit to test-results/migration/
#   6. tear down (unless KEEP_DB=1)
#
# Env:
#   KEEP_DB=1   leave the container running after the run
#   NO_DOWN=1   skip the (slow) rollback/reset suite

mkdir -p "${RESULTS_DIR}"

cleanup() {
  if [ "${KEEP_DB:-0}" = "1" ]; then
    log "KEEP_DB=1 — leaving container up (port ${TEST_DB_PORT})"
  else
    "${SCRIPT_DIR}/scripts/db-down.sh" || true
  fi
}
trap cleanup EXIT

"${SCRIPT_DIR}/scripts/db-up.sh"
"${SCRIPT_DIR}/scripts/migrate-up.sh"
"${SCRIPT_DIR}/scripts/db-seed.sh"

rc=0
bash "${SCRIPT_DIR}/tests/schema.test.sh" || rc=1
bash "${SCRIPT_DIR}/tests/idempotency.test.sh" || rc=1
if [ "${NO_DOWN:-0}" != "1" ]; then
  bash "${SCRIPT_DIR}/tests/rollback.test.sh" || rc=1
fi

if [ "${rc}" -eq 0 ]; then
  log "All migration tests passed. Results in ${RESULTS_DIR}"
else
  err "Migration tests failed. See ${RESULTS_DIR}"
fi
exit "${rc}"
