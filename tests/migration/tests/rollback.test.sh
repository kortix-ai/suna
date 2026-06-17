#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../scripts/env.sh"
source "${SCRIPT_DIR}/../scripts/junit.sh"

# Rollback / down test.
#
# The Supabase migration flow used by this repo is forward-only: there are no
# paired *.down.sql files. So "rollback" is exercised the way it actually
# happens in this project — `db-reset.sh` drops every application schema and
# re-applies from scratch, which must succeed cleanly.
#
# If/when paired down migrations are added (e.g. supabase/migrations/down/*.sql
# or a *.down.sql convention), extend this test to apply them in reverse order
# and assert the schema returns to empty.

junit_init "migration.rollback"

DOWN_GLOB1=("${SUPABASE_MIGRATIONS_DIR}"/*.down.sql)
DOWN_GLOB2=("${SUPABASE_MIGRATIONS_DIR}"/down/*.sql)
have_down=0
[ -e "${DOWN_GLOB1[0]}" ] && have_down=1
[ -e "${DOWN_GLOB2[0]}" ] && have_down=1

if [ "${have_down}" -eq 1 ]; then
  junit_case "down migrations detected" pass
  # Apply down migrations in reverse filename order, then assert empty schema.
  mapfile -t downs < <( { ls "${SUPABASE_MIGRATIONS_DIR}"/*.down.sql "${SUPABASE_MIGRATIONS_DIR}"/down/*.sql 2>/dev/null || true; } | sort -r )
  down_ok=1
  for f in "${downs[@]}"; do
    if ! compose exec -T -e PGPASSWORD="${TEST_DB_PASSWORD}" "${COMPOSE_SERVICE}" \
        psql -v ON_ERROR_STOP=1 --single-transaction \
        -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" < "${f}"; then
      down_ok=0
      break
    fi
  done
  if [ "${down_ok}" -eq 1 ]; then
    remaining="$(psql_query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'kortix'")"
    if [ "${remaining:-1}" -eq 0 ]; then
      junit_case "down migrations leave kortix schema empty" pass
    else
      junit_case "down migrations leave kortix schema empty" fail "${remaining} tables remain"
    fi
  else
    junit_case "down migrations apply cleanly" fail "a down migration errored"
  fi
else
  junit_case "no down migrations (forward-only flow) — using db-reset as rollback" pass
fi

# db-reset must drop + re-apply cleanly regardless of down-migration support.
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
