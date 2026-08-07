-- Migration: validate_task_git_write_fence
-- Validation scans existing rows without blocking concurrent writes.
set lock_timeout = '2s';
set statement_timeout = '5min';

ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_git_write_lease_pair";
ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_git_write_lease_within_worker_deadline";
ALTER TABLE "kortix"."project_tasks"
  VALIDATE CONSTRAINT "project_tasks_git_write_requires_doing_worker";
