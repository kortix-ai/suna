ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_worker_session_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_coordinator_session_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_worker_contract" jsonb;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_started_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_deadline_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_iterations_admitted" integer DEFAULT 0 NOT NULL;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "no_progress_settlements" smallint DEFAULT 0 NOT NULL;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "continuation_consumed_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_progress_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_progress_ref" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_settlement_id" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_action" text;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "last_no_progress_command_id" uuid;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "escalated_at" timestamp with time zone;
ALTER TABLE "kortix"."project_tasks" ADD COLUMN "liveness_blocker" text;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_worker_session_id_project_sessions_session_id_fk" FOREIGN KEY ("liveness_worker_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_coordinator_session_id_project_sessions_session_id_fk" FOREIGN KEY ("liveness_coordinator_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE no action ON UPDATE no action;
CREATE INDEX "idx_project_tasks_liveness_deadline" ON "kortix"."project_tasks" USING btree ("status","liveness_deadline_at") WHERE "kortix"."project_tasks"."liveness_worker_session_id" is not null;
CREATE UNIQUE INDEX "idx_project_tasks_liveness_worker" ON "kortix"."project_tasks" USING btree ("liveness_worker_session_id") WHERE "kortix"."project_tasks"."liveness_worker_session_id" is not null;
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_complete" CHECK (num_nonnulls("kortix"."project_tasks"."liveness_worker_session_id", "kortix"."project_tasks"."liveness_coordinator_session_id", "kortix"."project_tasks"."liveness_worker_contract", "kortix"."project_tasks"."liveness_started_at", "kortix"."project_tasks"."liveness_deadline_at") in (0, 5));
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_deadline_after_start" CHECK ("kortix"."project_tasks"."liveness_deadline_at" is null or "kortix"."project_tasks"."liveness_deadline_at" > "kortix"."project_tasks"."liveness_started_at");
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_worker_not_claimant" CHECK ("kortix"."project_tasks"."liveness_worker_session_id" is null or "kortix"."project_tasks"."liveness_worker_session_id" <> "kortix"."project_tasks"."claim_session_id");
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_no_progress_settlements_range" CHECK ("kortix"."project_tasks"."no_progress_settlements" between 0 and 2);
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_continuation_has_settlement" CHECK ("kortix"."project_tasks"."continuation_consumed_at" is null or "kortix"."project_tasks"."no_progress_settlements" >= 1);
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_liveness_contract_valid" CHECK ("kortix"."project_tasks"."liveness_worker_contract" is null or (
        jsonb_typeof("kortix"."project_tasks"."liveness_worker_contract") = 'object'
        and "kortix"."project_tasks"."liveness_worker_contract" ?& array['max_wall_seconds','max_tokens','max_cost_usd','max_iterations']
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_wall_seconds')::numeric > 0
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_wall_seconds')::numeric <= 86400
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_tokens')::numeric > 0
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_cost_usd')::numeric > 0
        and ("kortix"."project_tasks"."liveness_worker_contract"->>'max_iterations')::numeric > 0
      ));
ALTER TABLE "kortix"."project_tasks" ADD CONSTRAINT "project_tasks_last_no_progress_action_valid" CHECK ("kortix"."project_tasks"."last_no_progress_action" is null or "kortix"."project_tasks"."last_no_progress_action" in ('continuation_queued', 'blocked_escalation_queued'));