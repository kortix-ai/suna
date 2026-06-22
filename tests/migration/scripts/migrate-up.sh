#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Brings the throwaway Postgres up to the current schema with node-pg-migrate.
#
#   1. Apply the external prerequisites the baseline assumes — Supabase roles
#      (anon/authenticated/service_role) plus Auth/Basejump stubs — directly in
#      the container (packages/db/scripts/test-prereqs.sql).
#   2. Run the migrations from the host with the SAME `pnpm migrate` the deploy
#      pipeline uses. node-pg-migrate records applied migrations in
#      kortix_migrations.pgmigrations, so a second run is a no-op.

log "Applying external prerequisites (roles + auth/basejump stubs)"
compose exec -T -e PGPASSWORD="${TEST_DB_PASSWORD}" "${COMPOSE_SERVICE}" \
  psql -v ON_ERROR_STOP=1 -U "${TEST_DB_USER}" -d "${TEST_DB_NAME}" \
  <"${REPO_ROOT}/packages/db/scripts/test-prereqs.sql"

log "Applying migrations with node-pg-migrate (pnpm migrate)"
(cd "${REPO_ROOT}" && DATABASE_URL="${TEST_DATABASE_URL}" pnpm --filter @kortix/db migrate)

log "Done."
