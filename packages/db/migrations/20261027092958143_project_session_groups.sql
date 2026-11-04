-- Migration: project_session_groups
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Session groups (`session_groups` flag): kortix.project_session_groups holds a
-- project's named folders of sessions, in the order every member sees. The
-- table is new and empty: its checks, FKs and indexes scan nothing. RLS is on
-- with no policy: only the API (owner role) reads it.
--
-- project_sessions.group_id is a new nullable column: every existing row is
-- null and satisfies the FK, which is added NOT VALID (no scan under the
-- ACCESS EXCLUSIVE lock) and validated by 20261027092958145.
-- idx_project_sessions_group is built CONCURRENTLY by 20261027092958144.

CREATE TABLE "kortix"."project_session_groups" (
	"group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_session_groups_name_check" CHECK (char_length("kortix"."project_session_groups"."name") between 1 and 80),
	CONSTRAINT "project_session_groups_position_check" CHECK ("kortix"."project_session_groups"."position" >= 0)
);--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ADD CONSTRAINT "project_session_groups_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ADD CONSTRAINT "project_session_groups_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_session_groups_name" ON "kortix"."project_session_groups" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "idx_project_session_groups_project" ON "kortix"."project_session_groups" USING btree ("project_id","position");--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD CONSTRAINT "project_sessions_group_fk" FOREIGN KEY ("group_id") REFERENCES "kortix"."project_session_groups"("group_id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."project_session_groups" ENABLE ROW LEVEL SECURITY;
