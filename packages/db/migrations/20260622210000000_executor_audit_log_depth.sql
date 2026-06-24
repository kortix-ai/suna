ALTER TABLE "kortix"."executor_executions"
  ADD COLUMN IF NOT EXISTS "request_summary" jsonb,
  ADD COLUMN IF NOT EXISTS "duration_ms" integer;

CREATE INDEX IF NOT EXISTS "idx_executor_executions_project_created_at"
  ON "kortix"."executor_executions" ("project_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_executor_executions_action_path"
  ON "kortix"."executor_executions" ("action_path");
