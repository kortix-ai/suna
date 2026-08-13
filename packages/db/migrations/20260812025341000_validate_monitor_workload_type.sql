-- Migration: validate_monitor_workload_type
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
--
-- Validation takes SHARE UPDATE EXCLUSIVE. It does not block normal reads or
-- writes. Every existing workload_type value is 'session' or 'app', both of
-- which the widened constraint accepts, so the scan cannot fail.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."sandbox_compute_sessions"
  VALIDATE CONSTRAINT "sandbox_compute_sessions_workload_type_check";
