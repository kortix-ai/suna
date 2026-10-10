-- Migration: drives
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Five new, empty, server-only tables: nothing reads them before this deploys,
-- so the plain CREATE INDEX statements below block no traffic. Every
-- statement is idempotent, so a local or preview database that ran an
-- earlier build of this change converges instead of failing.
--
-- drives: one per project (kind `project`, shown as Files) backed by one
-- volume; `personal`, `agent` and `company` rows are the earlier drives a job
-- folds into project drives. drive_grants: those earlier drives' grants, read
-- only by that job. drive_conflicts: conflict copies the scanner found.
-- platinum_volume_deletions: volumes whose owner row is gone, drained by the
-- API. drive_mount_revocations: session sandboxes whose folder access narrowed
-- before their mounts did; fenced at the API and retried until in line.

CREATE TABLE IF NOT EXISTS "kortix"."drive_conflicts" (
	"conflict_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"path" text NOT NULL,
	"original_path" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."drive_grants" (
	"grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"subject_type" text DEFAULT 'project' NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"agent_name" text,
	"access" text DEFAULT 'write' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_grants_access" CHECK ("kortix"."drive_grants"."access" in ('read', 'write')),
	CONSTRAINT "drive_grants_subject" CHECK (("kortix"."drive_grants"."subject_type" = 'project' and "kortix"."drive_grants"."project_id" is not null and "kortix"."drive_grants"."user_id" is null and "kortix"."drive_grants"."agent_name" is null)
      or ("kortix"."drive_grants"."subject_type" = 'user' and "kortix"."drive_grants"."user_id" is not null and "kortix"."drive_grants"."project_id" is null and "kortix"."drive_grants"."agent_name" is null)
      or ("kortix"."drive_grants"."subject_type" = 'agent' and "kortix"."drive_grants"."project_id" is not null and "kortix"."drive_grants"."agent_name" is not null and "kortix"."drive_grants"."user_id" is null))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."drive_mount_revocations" (
	"sandbox_id" uuid PRIMARY KEY NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."drives" (
	"drive_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"project_id" uuid,
	"agent_name" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"platinum_volume_id" text,
	"platinum_volume_name" text NOT NULL,
	"conflict_scan_head" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drives_platinum_volume_name_key" UNIQUE("platinum_volume_name"),
	CONSTRAINT "drives_kind" CHECK ("kortix"."drives"."kind" in ('personal', 'agent', 'company', 'project'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kortix"."platinum_volume_deletions" (
	"volume_name" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_conflicts_drive_id_drives_drive_id_fk') THEN
    ALTER TABLE "kortix"."drive_conflicts" ADD CONSTRAINT "drive_conflicts_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_grants_drive_id_drives_drive_id_fk') THEN
    ALTER TABLE "kortix"."drive_grants" ADD CONSTRAINT "drive_grants_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_grants_project_id_projects_project_id_fk') THEN
    ALTER TABLE "kortix"."drive_grants" ADD CONSTRAINT "drive_grants_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drive_mount_revocations_sandbox_id_session_sandboxes_sandbox_id_fk') THEN
    ALTER TABLE "kortix"."drive_mount_revocations" ADD CONSTRAINT "drive_mount_revocations_sandbox_id_session_sandboxes_sandbox_id_fk" FOREIGN KEY ("sandbox_id") REFERENCES "kortix"."session_sandboxes"("sandbox_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drives_account_id_accounts_account_id_fk') THEN
    ALTER TABLE "kortix"."drives" ADD CONSTRAINT "drives_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'drives_project_id_projects_project_id_fk') THEN
    ALTER TABLE "kortix"."drives" ADD CONSTRAINT "drives_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drive_conflicts_drive_path" ON "kortix"."drive_conflicts" USING btree ("drive_id","path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drive_conflicts_open" ON "kortix"."drive_conflicts" USING btree ("drive_id") WHERE "kortix"."drive_conflicts"."resolved_at" is null and "kortix"."drive_conflicts"."dismissed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drive_grants_project_subject" ON "kortix"."drive_grants" USING btree ("drive_id","project_id") WHERE "kortix"."drive_grants"."subject_type" = 'project';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drive_grants_user_subject" ON "kortix"."drive_grants" USING btree ("drive_id","user_id") WHERE "kortix"."drive_grants"."subject_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drive_grants_agent_subject" ON "kortix"."drive_grants" USING btree ("drive_id","project_id","agent_name") WHERE "kortix"."drive_grants"."subject_type" = 'agent';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drive_grants_project" ON "kortix"."drive_grants" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drive_grants_user" ON "kortix"."drive_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drive_mount_revocations_due" ON "kortix"."drive_mount_revocations" USING btree ("not_before");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drives_account" ON "kortix"."drives" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_drives_project" ON "kortix"."drives" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drives_default_personal" ON "kortix"."drives" USING btree ("account_id","owner_user_id") WHERE "kortix"."drives"."kind" = 'personal' and "kortix"."drives"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drives_agent_per_project" ON "kortix"."drives" USING btree ("project_id","agent_name") WHERE "kortix"."drives"."kind" = 'agent';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drives_one_per_project" ON "kortix"."drives" USING btree ("project_id") WHERE "kortix"."drives"."kind" = 'project';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platinum_volume_deletions_due" ON "kortix"."platinum_volume_deletions" USING btree ("not_before");
--> statement-breakpoint

-- A database that ran an earlier build of this change keeps its tables; the
-- kind check is the one shape that changed.
-- mixed-version-safe: the table is new in this release, so no running API
-- version reads or writes it yet; the replacement accepts every earlier kind.
ALTER TABLE kortix.drives DROP CONSTRAINT IF EXISTS drives_kind;
--> statement-breakpoint
ALTER TABLE kortix.drives ADD CONSTRAINT drives_kind CHECK (kind in ('personal', 'agent', 'company', 'project'));
--> statement-breakpoint

-- Server-only: the API reads and writes these with its own role.
ALTER TABLE kortix.drives ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.drives FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE kortix.drive_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.drive_grants FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE kortix.drive_conflicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.drive_conflicts FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE kortix.platinum_volume_deletions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.platinum_volume_deletions FROM anon, authenticated;
--> statement-breakpoint
ALTER TABLE kortix.drive_mount_revocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.drive_mount_revocations FROM anon, authenticated;
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
DROP TRIGGER IF EXISTS drives_queue_volume_deletion ON kortix.drives;
--> statement-breakpoint
CREATE TRIGGER drives_queue_volume_deletion
AFTER DELETE ON kortix.drives
FOR EACH ROW EXECUTE FUNCTION kortix.queue_drive_volume_deletion();
