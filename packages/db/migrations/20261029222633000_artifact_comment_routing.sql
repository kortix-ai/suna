-- Migration: artifact_comment_routing
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- mixed-version-safe: the new nullable columns preserve old writers and the widened kind check accepts every old kind.
ALTER TABLE "kortix"."notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_threads" ADD COLUMN "agent_error" text;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD COLUMN "artifact_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD COLUMN "artifact_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_artifact_thread_fk" FOREIGN KEY ("artifact_thread_id") REFERENCES "kortix"."artifact_comment_threads"("thread_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_kind" CHECK ("kortix"."notifications"."kind" IN ('turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered', 'capture_device_down', 'capture_device_recovered', 'message', 'artifact_comment')) NOT VALID;
