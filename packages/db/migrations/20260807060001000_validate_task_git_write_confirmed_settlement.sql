-- Validate the task Git settlement invariants after the additive/backfill migration.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_tasks
  VALIDATE CONSTRAINT project_tasks_git_write_complete,
  VALIDATE CONSTRAINT project_tasks_git_write_state_valid,
  VALIDATE CONSTRAINT project_tasks_git_write_ref_valid,
  VALIDATE CONSTRAINT project_tasks_git_write_oid_valid,
  VALIDATE CONSTRAINT project_tasks_git_write_requires_doing_worker,
  VALIDATE CONSTRAINT project_tasks_terminal_has_no_live_fences;
