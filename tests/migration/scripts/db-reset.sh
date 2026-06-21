#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Drops all application schemas/objects and the migration bookkeeping, leaving a
# clean database in the SAME running container (no teardown). Use between test
# runs when you want a fresh apply without paying the container start cost.
#
# For a full teardown (container + volume), use db-down.sh instead.

log "Resetting test database ${TEST_DB_NAME}"

psql_exec -c "
DROP SCHEMA IF EXISTS kortix CASCADE;
DROP SCHEMA IF EXISTS basejump CASCADE;
DROP SCHEMA IF EXISTS supabase_migrations CASCADE;
" >/dev/null

log "Re-applying migrations from scratch"
"${SCRIPT_DIR}/migrate-up.sh"

log "Reset complete"
