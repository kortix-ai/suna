#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../scripts/env.sh"
source "${SCRIPT_DIR}/../scripts/junit.sh"

# Idempotency contract: re-running the migrate step against an already-migrated
# database must not error and must not re-apply anything. node-pg-migrate marks
# every migration in kortix_migrations.pgmigrations and reports "No migrations
# to run" on a second pass.

junit_init "migration.idempotency"

before="$(psql_query "SELECT count(*) FROM kortix_migrations.pgmigrations")"

if out="$("${SCRIPT_DIR}/../scripts/migrate-up.sh" 2>&1)"; then
  junit_case "second migrate run exits 0" pass
else
  junit_case "second migrate run exits 0" fail "re-apply errored: $(printf '%s' "${out}" | tail -3 | tr '\n' ' ')"
fi

after="$(psql_query "SELECT count(*) FROM kortix_migrations.pgmigrations")"
if [ "${before}" = "${after}" ]; then
  junit_case "no migrations re-applied (count stable at ${after})" pass
else
  junit_case "no migrations re-applied" fail "count changed ${before} -> ${after}"
fi

if printf '%s' "${out:-}" | grep -q "No migrations to run"; then
  junit_case "re-run reports 'No migrations to run'" pass
else
  junit_case "re-run reports 'No migrations to run'" fail "expected message not seen"
fi

junit_write "${RESULTS_DIR}/idempotency.xml"
junit_exit_code
