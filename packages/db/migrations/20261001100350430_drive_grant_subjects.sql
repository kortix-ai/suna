-- Migration: drive_grant_subjects
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

CREATE TABLE "kortix"."platinum_volume_deletions" (
	"volume_name" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- mixed-version-safe: drive_grants ships in this same release (20260928085803829_drives); no deployed code reads it yet.
ALTER TABLE "kortix"."drive_grants" DROP CONSTRAINT "drive_grants_drive_id_project_id_pk";--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD COLUMN "grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD COLUMN "subject_type" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD COLUMN "created_by" uuid;--> statement-breakpoint
CREATE INDEX "idx_platinum_volume_deletions_due" ON "kortix"."platinum_volume_deletions" USING btree ("not_before");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_grants_project_subject" ON "kortix"."drive_grants" USING btree ("drive_id","project_id") WHERE "kortix"."drive_grants"."subject_type" = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX "drive_grants_user_subject" ON "kortix"."drive_grants" USING btree ("drive_id","user_id") WHERE "kortix"."drive_grants"."subject_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "drive_grants_agent_subject" ON "kortix"."drive_grants" USING btree ("drive_id","project_id","agent_name") WHERE "kortix"."drive_grants"."subject_type" = 'agent';--> statement-breakpoint
CREATE INDEX "idx_drive_grants_user" ON "kortix"."drive_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "kortix"."drive_grants" ADD CONSTRAINT "drive_grants_subject" CHECK (("kortix"."drive_grants"."subject_type" = 'project' and "kortix"."drive_grants"."project_id" is not null and "kortix"."drive_grants"."user_id" is null and "kortix"."drive_grants"."agent_name" is null)
      or ("kortix"."drive_grants"."subject_type" = 'user' and "kortix"."drive_grants"."user_id" is not null and "kortix"."drive_grants"."project_id" is null and "kortix"."drive_grants"."agent_name" is null)
      or ("kortix"."drive_grants"."subject_type" = 'agent' and "kortix"."drive_grants"."project_id" is not null and "kortix"."drive_grants"."agent_name" is not null and "kortix"."drive_grants"."user_id" is null));
--> statement-breakpoint
ALTER TABLE kortix.platinum_volume_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.platinum_volume_deletions FROM anon, authenticated;
--> statement-breakpoint
-- Every delete path of a drive (its own route, a project or account cascade)
-- queues its volume; the API drains the queue (missing_ok, retries while busy).
CREATE OR REPLACE FUNCTION kortix.queue_drive_volume_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kortix.platinum_volume_deletions (volume_name, reason)
  VALUES (OLD.platinum_volume_name, 'drive_deleted')
  ON CONFLICT (volume_name) DO NOTHING;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER drives_queue_volume_deletion
AFTER DELETE ON kortix.drives
FOR EACH ROW EXECUTE FUNCTION kortix.queue_drive_volume_deletion();
--> statement-breakpoint
-- An ephemeral session's state volume, when its session row goes (a project
-- or account cascade; the session delete route queues it itself).
CREATE OR REPLACE FUNCTION kortix.queue_session_state_volume_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(OLD.metadata ->> 'ephemeral_state_volume', '') <> '' THEN
    INSERT INTO kortix.platinum_volume_deletions (volume_name, reason)
    VALUES (OLD.metadata ->> 'ephemeral_state_volume', 'session_deleted')
    ON CONFLICT (volume_name) DO NOTHING;
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_sessions_queue_state_volume_deletion
AFTER DELETE ON kortix.project_sessions
FOR EACH ROW EXECUTE FUNCTION kortix.queue_session_state_volume_deletion();
