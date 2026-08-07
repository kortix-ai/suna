-- Migration: validate_task_worker_platform_ceiling
-- Validation scans existing rows without blocking concurrent writes.
set lock_timeout = '2s';
set statement_timeout = '5min';

ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_liveness_contract_platform_ceiling";
