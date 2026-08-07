-- Migration: validate_kortix_apps_compute_constraints
--
-- Validation takes SHARE UPDATE EXCLUSIVE. It does not block normal reads or
-- writes. The columns are additive. Existing app_runtime_id values are NULL,
-- and workload_type received the constant session default at column creation.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."sandbox_compute_sessions"
  VALIDATE CONSTRAINT "sandbox_compute_sessions_app_runtime_fk";

ALTER TABLE "kortix"."sandbox_compute_sessions"
  VALIDATE CONSTRAINT "sandbox_compute_sessions_workload_type_check";
