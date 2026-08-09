-- Migration: add_task_liveness_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Safe deployment assumption:
-- 20260806225037066_add_project_generated_state.sql creates project_tasks
-- before this migration. Both migrations ship before any API build reads or
-- writes liveness fields. The table can contain generated tasks from an old API
-- pod, so every added column is nullable or has a constant default. Existing
-- rows need no backfill. Old API pods ignore all new columns and constraints.
--
-- Indexes on project_tasks are intentionally absent here. The two following
-- .concurrent.ts migrations build them outside the migration transaction.
-- Checks and foreign keys on project_tasks use NOT VALID. A later migration
-- validates them without holding ACCESS EXCLUSIVE for the table scan.

ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_worker_session_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_coordinator_session_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_worker_contract" jsonb;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_started_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_deadline_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_iterations_admitted" integer DEFAULT 0 NOT NULL;
-- Bounded by a CHECK to 0..2; 16 bits cannot exhaust.
-- squawk-ignore prefer-bigint-over-smallint
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "no_progress_settlements" smallint DEFAULT 0 NOT NULL;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "continuation_consumed_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_progress_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_progress_ref" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_settlement_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_action" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_command_id" uuid;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "escalated_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_blocker" text;

-- Drizzle owns this stable generated constraint name; PostgreSQL truncates it consistently.
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_worker_session_id_project_sessions_session_id_fk"
  FOREIGN KEY ("liveness_worker_session_id") REFERENCES "kortix"."project_sessions"("session_id")
  ON DELETE no action ON UPDATE no action NOT VALID;
-- Drizzle owns this stable generated constraint name; PostgreSQL truncates it consistently.
-- squawk-ignore identifier-too-long
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_coordinator_session_id_project_sessions_session_id_fk"
  FOREIGN KEY ("liveness_coordinator_session_id") REFERENCES "kortix"."project_sessions"("session_id")
  ON DELETE no action ON UPDATE no action NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_complete"
  CHECK (num_nonnulls("liveness_worker_session_id", "liveness_coordinator_session_id", "liveness_worker_contract", "liveness_started_at", "liveness_deadline_at") in (0, 5)) NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_deadline_after_start"
  CHECK ("liveness_deadline_at" is null or "liveness_deadline_at" > "liveness_started_at") NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_worker_not_claimant"
  CHECK ("liveness_worker_session_id" is null or "liveness_worker_session_id" <> "claim_session_id") NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_no_progress_settlements_range"
  CHECK ("no_progress_settlements" between 0 and 2) NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_continuation_has_settlement"
  CHECK ("continuation_consumed_at" is null or "no_progress_settlements" >= 1) NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_contract_valid"
  CHECK ("liveness_worker_contract" is null or (
    jsonb_typeof("liveness_worker_contract") = 'object'
    and "liveness_worker_contract" ?& array['max_wall_seconds','max_tokens','max_cost_usd','max_iterations']
    and ("liveness_worker_contract"->>'max_wall_seconds')::numeric > 0
    and ("liveness_worker_contract"->>'max_wall_seconds')::numeric <= 86400
    and ("liveness_worker_contract"->>'max_tokens')::numeric > 0
    and ("liveness_worker_contract"->>'max_cost_usd')::numeric > 0
    and ("liveness_worker_contract"->>'max_iterations')::numeric > 0
    and ("liveness_worker_contract"->>'max_iterations')::numeric <= 2147483647
  )) NOT VALID;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_last_no_progress_action_valid"
  CHECK ("last_no_progress_action" is null or "last_no_progress_action" in ('continuation_queued', 'blocked_escalation_queued')) NOT VALID;
