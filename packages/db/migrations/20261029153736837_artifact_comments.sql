-- Migration: artifact_comments
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

CREATE TABLE "kortix"."artifact_comment_threads" (
	"thread_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"anchor" jsonb NOT NULL,
	"anchor_version" text NOT NULL,
	"created_by_user_id" uuid,
	"created_by_session_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_by_session_id" text,
	"resolved_at" timestamp with time zone,
	"agent_state" text DEFAULT 'none' NOT NULL,
	"sent_session_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_comment_threads_author_check" CHECK (("kortix"."artifact_comment_threads"."created_by_user_id" is not null) <> ("kortix"."artifact_comment_threads"."created_by_session_id" is not null)),
	CONSTRAINT "artifact_comment_threads_status_check" CHECK ("kortix"."artifact_comment_threads"."status" in ('open', 'resolved')),
	CONSTRAINT "artifact_comment_threads_agent_state_check" CHECK ("kortix"."artifact_comment_threads"."agent_state" in ('none', 'pending', 'sent', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "kortix"."artifact_comment_write_limits" (
	"artifact_id" uuid NOT NULL,
	"actor_key" text NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "artifact_comment_write_limits_artifact_id_actor_key_pk" PRIMARY KEY("artifact_id","actor_key"),
	CONSTRAINT "artifact_comment_write_limits_writes_check" CHECK ("kortix"."artifact_comment_write_limits"."writes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "kortix"."artifact_comments" (
	"comment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_session_id" text,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"marks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"screenshot_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "artifact_comments_author_check" CHECK (("kortix"."artifact_comments"."author_user_id" is not null) <> ("kortix"."artifact_comments"."author_session_id" is not null)),
	CONSTRAINT "artifact_comments_body_check" CHECK (char_length("kortix"."artifact_comments"."body") <= 10000 and ("kortix"."artifact_comments"."deleted_at" is not null or char_length("kortix"."artifact_comments"."body") >= 1))
);
--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_threads" ADD CONSTRAINT "artifact_comment_threads_artifact_id_artifacts_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_threads" ADD CONSTRAINT "artifact_comment_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comment_write_limits" ADD CONSTRAINT "artifact_comment_write_limits_artifact_fk" FOREIGN KEY ("artifact_id") REFERENCES "kortix"."artifacts"("artifact_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."artifact_comments" ADD CONSTRAINT "artifact_comments_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "kortix"."artifact_comment_threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_artifact_comment_threads_artifact_status_updated" ON "kortix"."artifact_comment_threads" USING btree ("artifact_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_artifact_comment_threads_project" ON "kortix"."artifact_comment_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_artifact_comments_thread_created" ON "kortix"."artifact_comments" USING btree ("thread_id","created_at");

-- backfill-safe: one permission catalog row and at most two built-in role rows.
-- New comment tables are empty; no customer data is scanned or rewritten.
INSERT INTO kortix.permissions
  (action, scope_type, resource_type, delegable, description, area, level, implies)
VALUES
  ('project.artifact.comment', 'project', 'project', true,
   'Open and reply to artifact comment threads.', 'artifacts', 'edit', ARRAY['project.artifact.read']::text[])
ON CONFLICT (action) DO NOTHING;

INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'project.artifact.comment'
  FROM kortix.iam_roles r
 WHERE r.account_id IS NULL AND r.key IN ('manager', 'member') AND r.scope_type = 'project'
ON CONFLICT (role_id, action) DO NOTHING;
