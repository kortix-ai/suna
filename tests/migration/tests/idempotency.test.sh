#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../scripts/env.sh"
source "${SCRIPT_DIR}/../scripts/junit.sh"

# Idempotency contract: re-running the migrate step against an already-migrated
# database must not error and must not re-apply anything (the bookkeeping table
# marks every version as applied). This mirrors `supabase db push` being run
# twice in CI.

junit_init "migration.idempotency"

before="$(psql_query "SELECT count(*) FROM supabase_migrations.schema_migrations")"

if out="$("${SCRIPT_DIR}/../scripts/migrate-up.sh" 2>&1)"; then
  junit_case "second migrate-up run exits 0" pass
else
  junit_case "second migrate-up run exits 0" fail "re-apply errored: $(printf '%s' "${out}" | tail -3 | tr '\n' ' ')"
fi

after="$(psql_query "SELECT count(*) FROM supabase_migrations.schema_migrations")"
if [ "${before}" = "${after}" ]; then
  junit_case "no migrations re-applied (count stable at ${after})" pass
else
  junit_case "no migrations re-applied" fail "count changed ${before} -> ${after}"
fi

applied_zero="$(printf '%s' "${out:-}" | grep -oE 'applied=[0-9]+' | head -1 || true)"
if [ "${applied_zero}" = "applied=0" ]; then
  junit_case "re-run reports applied=0" pass
else
  junit_case "re-run reports applied=0" fail "got '${applied_zero:-none}'"
fi

junit_write "${RESULTS_DIR}/idempotency.xml"
junit_exit_code
