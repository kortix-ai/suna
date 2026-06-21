#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Drops all application schemas + the node-pg-migrate tracking schema, leaving a
# clean database in the SAME running container (no teardown), then re-applies
# from scratch. Use between test runs to get a fresh apply without paying the
# container start cost. For a full teardown (container + volume), use db-down.sh.

log "Resetting test database ${TEST_DB_NAME}"

psql_exec -c "
DROP SCHEMA IF EXISTS kortix CASCADE;
DROP SCHEMA IF EXISTS basejump CASCADE;
DROP SCHEMA IF EXISTS kortix_migrations CASCADE;
DROP TABLE IF EXISTS public.daily_refresh_tracking CASCADE;
DROP TABLE IF EXISTS public.renewal_processing CASCADE;
" >/dev/null

log "Re-applying migrations from scratch"
"${SCRIPT_DIR}/migrate-up.sh"

log "Reset complete"
