-- Migration: app_deployments_deleted_status
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Widen the app_deployments status CHECK to admit 'deleted'. An owner can now
-- delete one non-live deployment: `DELETE /projects/:id/apps/:appId/
-- deployments/:deploymentId` removes its runtimes and its provider image
-- (`kortix-app-<deploymentId>`), then marks the row 'deleted'. The row stays
-- for version numbering and audit; every read hides it.
--
-- mixed-version-safe: the change only ADDS an accepted value. Old code writes
-- only the eight existing values, which both the old and the new constraint
-- accept, and no stored row can violate the wider set. Old code that reads a
-- 'deleted' row during the rollout window treats it as non-ready: the rollback
-- route requires status = 'ready', the deployment worker claims only 'queued',
-- and snapshot quota GC protects only 'ready'. The live deployment can never be
-- 'deleted' (the route refuses it), so the public proxy never resolves one.
--
-- NOT VALID + a separate VALIDATE (next migration), matching the
-- monitor_workload_type pair (20260812025340636 / 20260812025341000).
ALTER TABLE "kortix"."app_deployments" DROP CONSTRAINT "app_deployments_status_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_status_check" CHECK ("kortix"."app_deployments"."status" IN ('queued', 'validating', 'building', 'provisioning', 'checking', 'ready', 'failed', 'cancelled', 'deleted')) NOT VALID;
