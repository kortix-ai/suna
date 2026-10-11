-- Migration: backend_workload_type
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Widen the workload_type CHECK to admit a Kortix Backend machine. Backends are
-- metered like sandboxes: reserved spec x wall clock, one compute window per
-- backend, `sandbox_id` = `project_backends.backend_id`. A pure WIDENING: the
-- accepted set grows from {session, app, monitor} to {session, app, monitor,
-- backend}.
--
-- mixed-version-safe: the change only ADDS an accepted value. Old code writes
-- only 'session', 'app' and 'monitor', which both the old and the new
-- constraint accept, so an old writer can never violate the new constraint, and
-- no stored row can either. A rollback to old code keeps working: it branches
-- on `= 'app'` / `= 'monitor'` and treats any other value as a session window.
--
-- NOT VALID + a separate VALIDATE (next migration) so the ADD takes only a
-- brief ACCESS EXCLUSIVE lock instead of holding it for a full scan of
-- sandbox_compute_sessions. Mirrors 20260812025340636 / 20260812025341000.
ALTER TABLE "kortix"."sandbox_compute_sessions" DROP CONSTRAINT "sandbox_compute_sessions_workload_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."sandbox_compute_sessions" ADD CONSTRAINT "sandbox_compute_sessions_workload_type_check" CHECK ("kortix"."sandbox_compute_sessions"."workload_type" IN ('session', 'app', 'monitor', 'backend')) NOT VALID;
