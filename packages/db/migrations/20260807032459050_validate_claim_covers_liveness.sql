-- Migration: validate_claim_covers_liveness
-- Validation scans existing rows without blocking concurrent writes.
set lock_timeout = '2s';
set statement_timeout = '5min';

ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_claim_covers_liveness";
