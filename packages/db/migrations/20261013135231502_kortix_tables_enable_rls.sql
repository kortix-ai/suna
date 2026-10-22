-- Migration: kortix_tables_enable_rls
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Pentest M-3: 136 of 169 kortix tables had RLS off, so client isolation rested
-- on one REVOKE (20260924194804787_client_role_lockdown) that an earlier
-- migration had already undone once (20260704160000000). RLS with no policy
-- denies every row to every role that neither owns the table nor has
-- BYPASSRLS; the API (postgres), service_role and the replication role are
-- unaffected. ENABLE, deliberately not FORCE (see
-- 20260811140504477_impersonation_grants_lock_down). Dynamic, so a table that
-- exists in one environment only is covered too. Each ALTER is a catalog flip:
-- the ACCESS EXCLUSIVE lock is held for milliseconds, bounded by lock_timeout.
-- Partitions inherit the parent's policy for every query through the parent.
--
-- Also revokes the `authenticator` table grants dev still carried: PostgREST
-- only ever acts as anon/authenticated, never with the login role's own grants.
DO $$
DECLARE
  rel record;
BEGIN
  FOR rel IN
    SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'kortix'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
       AND NOT c.relrowsecurity
     ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE kortix.%I ENABLE ROW LEVEL SECURITY', rel.relname);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA kortix FROM authenticator;
  END IF;
END $$;
