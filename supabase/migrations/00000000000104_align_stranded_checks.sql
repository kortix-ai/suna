-- ============================================================================
-- 00000000000104  align_stranded_checks
-- Re-assert CHECK constraints that only ever lived inside `CREATE TABLE` bodies.
--
-- Why these go missing: in dev/staging the schema runner does `drizzle-kit
-- push` FIRST (which creates these tables from packages/db/src/schema/kortix.ts)
-- and the Drizzle schema cannot express CHECK constraints. The SQL migrations
-- that DO define the checks use `CREATE TABLE IF NOT EXISTS`, which becomes a
-- no-op once push already created the table — so the checks are silently never
-- applied. (On a clean `supabase db reset`, the inline checks DO apply; this
-- file is a guarded no-op there.)
--
-- Same guarded `ALTER ... ADD CONSTRAINT ... NOT VALID` pattern as migration
-- 099. NOT VALID enforces the check on new/updated rows without validating
-- pre-existing rows (no failure on legacy data). The conname guard makes it
-- idempotent and converges with the fresh-reset path (which creates the same
-- named constraints inline in migration 098).
-- ============================================================================

-- legacy_sandbox_migrations.mode — migration 101 re-added the `status` check via
-- ALTER but not `mode`, so mode is the stranded one for this table.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_sandbox_migrations_mode_check'
      AND conrelid = 'kortix."legacy_sandbox_migrations"'::regclass
  ) THEN
    ALTER TABLE kortix."legacy_sandbox_migrations"
      ADD CONSTRAINT "legacy_sandbox_migrations_mode_check"
      CHECK (((mode)::text = ANY ((ARRAY['dry_run'::character varying, 'apply'::character varying, 'verify'::character varying, 'rollback'::character varying])::text[]))) NOT VALID;
  END IF;
END $$;

-- project_snapshot_builds.status
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_snapshot_builds_status_check'
      AND conrelid = 'kortix."project_snapshot_builds"'::regclass
  ) THEN
    ALTER TABLE kortix."project_snapshot_builds"
      ADD CONSTRAINT "project_snapshot_builds_status_check"
      CHECK ((status = ANY (ARRAY['building'::text, 'ready'::text, 'failed'::text]))) NOT VALID;
  END IF;
END $$;

-- sandbox_compute_sessions.state — billing table; the per-second metering cron
-- keys off `state = 'active'`, so an invalid value would corrupt billing state.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sandbox_compute_sessions_state_check'
      AND conrelid = 'kortix."sandbox_compute_sessions"'::regclass
  ) THEN
    ALTER TABLE kortix."sandbox_compute_sessions"
      ADD CONSTRAINT "sandbox_compute_sessions_state_check"
      CHECK ((state = ANY (ARRAY['active'::text, 'stopped'::text, 'finalized'::text]))) NOT VALID;
  END IF;
END $$;
