-- Migration: validate_final_autonomy_audit_hardening
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_goal_evaluations
  VALIDATE CONSTRAINT project_goal_evaluations_fired_at_valid;

ALTER TABLE kortix.project_tasks
  VALIDATE CONSTRAINT project_tasks_turn_requires_doing_worker;
