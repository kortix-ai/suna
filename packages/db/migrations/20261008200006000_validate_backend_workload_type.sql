-- Migration: validate_backend_workload_type
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validation takes SHARE UPDATE EXCLUSIVE. It does not block normal reads or
-- writes. Every stored workload_type value is 'session', 'app' or 'monitor',
-- all of which the widened constraint accepts, so the scan cannot fail.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."sandbox_compute_sessions"
  VALIDATE CONSTRAINT "sandbox_compute_sessions_workload_type_check";
