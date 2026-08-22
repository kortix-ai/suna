-- Migration: monitor_workload_type
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- Widen the workload_type CHECK to admit the monitor box
-- (docs/specs/2026-08-12-monitors.md D3). This is a pure WIDENING: the accepted
-- set grows from {session, app} to {session, app, monitor}.
--
-- mixed-version-safe: the change only ADDS an accepted value. Old code writes
-- only 'session' and 'app', which both the old and the new constraint accept,
-- so an old writer can never violate the new constraint; and no existing row
-- can violate it either, since every stored value was already in the old set.
-- A rollback to old code likewise keeps working — it never reads
-- workload_type as an exhaustive union, it branches on `= 'app'`.
--
-- NOT VALID + a separate VALIDATE (next migration) so the ADD takes only a
-- brief ACCESS EXCLUSIVE lock instead of holding it for a full scan of
-- sandbox_compute_sessions, which is one of the larger tables here. Mirrors
-- the pair this same constraint was born in (20260807014957296 /
-- 20260807015000000).
ALTER TABLE "kortix"."sandbox_compute_sessions" DROP CONSTRAINT "sandbox_compute_sessions_workload_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_workload_type_check" CHECK ("kortix"."sandbox_compute_sessions"."workload_type" IN ('session', 'app', 'monitor')) NOT VALID;