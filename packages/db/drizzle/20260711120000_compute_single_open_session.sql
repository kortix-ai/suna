CREATE UNIQUE INDEX IF NOT EXISTS "uniq_sandbox_compute_sessions_one_open"
ON "kortix"."sandbox_compute_sessions" USING btree ("sandbox_id")
WHERE "ended_at" IS NULL;
