-- Migration: validate_terminal_task_live_fence
-- Validation scans existing rows without blocking concurrent writes.
set lock_timeout = '2s';
set statement_timeout = '5min';

ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_terminal_has_no_live_fences";
