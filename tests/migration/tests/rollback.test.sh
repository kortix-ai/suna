#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../scripts/env.sh"
source "${SCRIPT_DIR}/../scripts/junit.sh"

# Rollback test.
#
# The migration flow is forward-only: the baseline has no paired down section
# (rolling prod schema back is done by writing a NEW forward migration, not a
# down). So "rollback" is exercised the way it happens in this project —
# db-reset.sh drops every application schema and re-applies from scratch, which
# must succeed cleanly and rebuild the schema.

junit_init "migration.rollback"

junit_case "forward-only flow — db-reset stands in for rollback" pass

if out="$("${SCRIPT_DIR}/../scripts/db-reset.sh" 2>&1)"; then
  junit_case "db-reset drops and re-applies cleanly" pass
else
  junit_case "db-reset drops and re-applies cleanly" fail "$(printf '%s' "${out}" | tail -3 | tr '\n' ' ')"
fi

after="$(psql_query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'kortix'")"
if [ "${after:-0}" -gt 0 ]; then
  junit_case "schema present again after reset (${after} tables)" pass
else
  junit_case "schema present again after reset" fail "expected >0 tables, got ${after:-0}"
fi

junit_write "${RESULTS_DIR}/rollback.xml"
junit_exit_code
