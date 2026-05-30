-- Durable, resumable, uncancellable legacy-sandbox migrations.
--
-- The original legacy_sandbox_migrations table modelled a one-shot CLI run
-- (plan -> apply -> verify in a single DB transaction). The lazy, user-triggered
-- flow needs to survive crashes/redeploys mid-migration: long I/O steps (SSH
-- backup of the JustAVPS VM, Freestyle repo create + push) run OUTSIDE any
-- transaction and can be interrupted at any point. We make the DB row the source
-- of truth so a background worker can resume from the last completed step.
--
-- State that the resume worker must query efficiently lives in real columns
-- (status, phase, heartbeat_at). Bulky per-step artifacts (backup url, repo id,
-- discovered opencode session ids, ...) live in the `progress` jsonb blob.

ALTER TABLE "kortix"."legacy_sandbox_migrations"
  -- Current step in the durable pipeline (extract -> repo -> push -> db -> done).
  -- NULL for legacy CLI rows that never used the durable runner.
  ADD COLUMN IF NOT EXISTS "phase" varchar(32),
  -- Mutable checkpoint state accumulated as steps complete. Distinct from `plan`
  -- (the immutable migration plan) and `rollback` (undo recipe).
  ADD COLUMN IF NOT EXISTS "progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- Retry counter for the current phase; drives backoff + dead-lettering.
  ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL,
  -- Lease/liveness. A worker bumps this while actively driving the row; the
  -- resume loop reclaims `running` rows whose heartbeat has gone stale.
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone,
  -- When the durable run first transitioned to `running`.
  ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone;

-- Allow the two new lifecycle states used by the durable runner:
--   running   — long steps in flight (uncancellable; reclaimable on crash)
--   completed — durable run finished end-to-end (distinct from the CLI's
--               'applied'/'verified', which only covered the DB transaction)
ALTER TABLE "kortix"."legacy_sandbox_migrations"
  DROP CONSTRAINT IF EXISTS "legacy_sandbox_migrations_status_check";
ALTER TABLE "kortix"."legacy_sandbox_migrations"
  ADD CONSTRAINT "legacy_sandbox_migrations_status_check"
    CHECK ("status" IN ('planned', 'running', 'applied', 'verified', 'completed', 'rolled_back', 'failed'));

-- Dedup guarantee for the "user clicks Migrate" path. The original index only
-- covered finished rows ('applied','verified'), so two concurrent starts (double
-- click / two tabs) could each insert a `running` row. Widen the predicate so an
-- in-flight migration also holds the lock: at most one active migration per
-- sandbox, enforced by Postgres rather than by racing app code.
DROP INDEX IF EXISTS "kortix"."idx_legacy_sandbox_migrations_active_sandbox";
CREATE UNIQUE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_active_sandbox"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("sandbox_id")
  WHERE "status" IN ('planned', 'running', 'applied', 'verified', 'completed');

-- Resume-loop scan: find live runs whose lease has gone stale.
CREATE INDEX IF NOT EXISTS "idx_legacy_sandbox_migrations_heartbeat"
  ON "kortix"."legacy_sandbox_migrations" USING btree ("status", "heartbeat_at");
