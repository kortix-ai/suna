-- Migration: validate_task_liveness_concurrency
set lock_timeout = '2s';
set statement_timeout = '5min';

alter table kortix.project_tasks
  validate constraint project_tasks_liveness_admission_complete;
alter table kortix.project_tasks
  validate constraint project_tasks_liveness_admission_within_deadline;
