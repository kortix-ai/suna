-- Migration: project_trigger_runtime_space
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Channels: a trigger posts its runs to a channel or DM as threads.
-- project_trigger_runtime.space_id is a new nullable column, so every existing
-- row is null and satisfies the FK. The FK is added NOT VALID (no scan under
-- the ACCESS EXCLUSIVE lock); 20261025190616832 validates it.
-- idx_project_trigger_runtime_space is built CONCURRENTLY by 20261025190616831.

ALTER TABLE "kortix"."project_trigger_runtime" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" ADD CONSTRAINT "project_trigger_runtime_space_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE set null ON UPDATE no action NOT VALID;
