#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

# Drops all application schemas + the node-pg-migrate tracking schema, leaving a
# clean database in the SAME running container (no teardown), then re-applies
# from scratch. Use between test runs to get a fresh apply without paying the
# container start cost. For a full teardown (container + volume), use db-down.sh.
#
# Migrations also create routines directly in public (the credit RPCs). Those
# survive the schema drops, and a later migration can change their parameter
# defaults — then the baseline's CREATE OR REPLACE fails with 42P13 ("cannot
# remove parameter defaults"). Drop every non-extension routine in public so a
# reset re-applies onto the same state as a fresh database.

log "Resetting test database ${TEST_DB_NAME}"

psql_exec -c "
DROP SCHEMA IF EXISTS kortix CASCADE;
DROP SCHEMA IF EXISTS basejump CASCADE;
DROP SCHEMA IF EXISTS kortix_migrations CASCADE;
DROP TABLE IF EXISTS public.daily_refresh_tracking CASCADE;
DROP TABLE IF EXISTS public.renewal_processing CASCADE;
DO \$\$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.prokind IN ('f', 'p')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('DROP ROUTINE %s CASCADE', r.sig);
  END LOOP;
END
\$\$;
" >/dev/null

log "Re-applying migrations from scratch"
"${SCRIPT_DIR}/migrate-up.sh"

log "Reset complete"
