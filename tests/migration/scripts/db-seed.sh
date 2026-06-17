#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Loads deterministic seed data for integration tests. Runs every *.sql in
# fixtures/ in filename order. Seeds are idempotent (ON CONFLICT DO NOTHING).
FIXTURES_DIR="${MIGRATION_DIR}/fixtures"

shopt -s nullglob
files=("${FIXTURES_DIR}"/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  log "No fixtures in ${FIXTURES_DIR} — nothing to seed"
  exit 0
fi

for file in "${files[@]}"; do
  log "Seeding $(basename "${file}")"
  compose exec -T -e PGPASSWORD="${TEST_DB_PASSWORD}" "${COMPOSE_SERVICE}" \
    psql -v ON_ERROR_STOP=1 -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" < "${file}"
done

log "Seed complete"
