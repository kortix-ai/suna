-- Migration: validate_task_liveness_policy
--
-- Validates the constraints created NOT VALID by
-- 20260807002636000_add_task_liveness_policy.sql. VALIDATE holds SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while PostgreSQL scans project_tasks.
set lock_timeout = '2s';
set statement_timeout = '5min';

-- PostgreSQL uses the same deterministic truncation as the ADD CONSTRAINT statement.
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_worker_session_id_project_sessions_session_id_fk";
-- PostgreSQL uses the same deterministic truncation as the ADD CONSTRAINT statement.
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_coordinator_session_id_project_sessions_session_id_fk";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_complete";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_deadline_after_start";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_worker_not_claimant";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_no_progress_settlements_range";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_continuation_has_settlement";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_liveness_contract_valid";
ALTER TABLE "kortix"."project_tasks" VALIDATE CONSTRAINT "project_tasks_last_no_progress_action_valid";
