#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Applies every supabase/migrations/*.sql in filename order, inside the
# postgres container, via psql piped over stdin. No host tooling required.
#
# A schema_migrations bookkeeping table records what has been applied so a
# second run is a no-op (idempotency contract for the supabase CLI too).

log "Bootstrapping Supabase roles"
compose exec -T -e PGPASSWORD="${TEST_DB_PASSWORD}" "${COMPOSE_SERVICE}" \
  psql -v ON_ERROR_STOP=1 -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" \
  < "${SCRIPT_DIR}/bootstrap-roles.sql"

log "Ensuring bookkeeping table"
psql_exec -c "CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);" >/dev/null

shopt -s nullglob
files=("${SUPABASE_MIGRATIONS_DIR}"/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  err "No migration files found in ${SUPABASE_MIGRATIONS_DIR}"
  exit 1
fi

applied=0
skipped=0
for file in "${files[@]}"; do
  version="$(basename "${file}" .sql)"
  already="$(psql_query "SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '${version}'")"
  if [ "${already}" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  log "Applying ${version}"
  compose exec -T -e PGPASSWORD="${TEST_DB_PASSWORD}" "${COMPOSE_SERVICE}" \
    psql -v ON_ERROR_STOP=1 --single-transaction \
    -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" < "${file}"

  psql_exec -c "INSERT INTO supabase_migrations.schema_migrations (version)
                VALUES ('${version}') ON CONFLICT (version) DO NOTHING;" >/dev/null
  applied=$((applied + 1))
done

log "Done. applied=${applied} skipped(already-present)=${skipped} total=${#files[@]}"
