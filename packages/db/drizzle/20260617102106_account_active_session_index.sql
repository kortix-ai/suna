-- Custom SQL migration file, put your code below! --

-- Partial composite index for the concurrency-cap COUNT run on EVERY session
-- create (countActiveProjectSessions → checkConcurrentSessionCap):
--   SELECT count(*) FROM kortix.project_sessions
--   WHERE account_id = $1 AND status IN ('queued','branching','provisioning','running');
-- Without it Postgres uses idx_project_sessions_account and heap-filters status,
-- walking an account's FULL session history (terminal stopped/failed/completed
-- rows accumulate with no archival). This partial index covers ONLY the bounded
-- active set, so the count stays O(active) instead of O(total history).
--
-- Authored as a --custom migration (NOT generated from the schema) on purpose:
--   1. It must NOT entangle the unmigrated provider_events / 'platinum'-enum
--      schema drift that a plain `db:generate` would otherwise bundle in.
--   2. `drizzle-kit migrate` wraps each file in a transaction, so CREATE INDEX
--      CONCURRENTLY is not usable here. A partial index over only the active set
--      builds fast, so the brief build-time lock is acceptable. If
--      project_sessions is ever large enough that the build lock matters, an
--      operator may build it out-of-band first:
--        CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_project_sessions_account_active
--          ON kortix.project_sessions (account_id)
--          WHERE status IN ('queued','branching','provisioning','running');
--      (run outside any migration), after which this IF NOT EXISTS statement no-ops.
--
-- The predicate MUST stay in sync with ACTIVE_SESSION_STATUSES in
-- apps/api/src/projects/lib/serializers.ts.
CREATE INDEX IF NOT EXISTS "idx_project_sessions_account_active"
  ON "kortix"."project_sessions" ("account_id")
  WHERE status IN ('queued', 'branching', 'provisioning', 'running');
