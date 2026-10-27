-- Migration: project_channels
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Channels: kortix.project_spaces holds channels and DMs; a thread is a
-- project_sessions row with space_id. The five tables below are new and empty:
-- their indexes, checks and FKs take no lock on a populated table they would
-- have to scan. RLS is on with no policy: only the API (owner role) reads them.
--
-- - project_spaces: a channel or a DM, its agents (in order; the first is the
--   default) and its visibility (`private`: only its members, never #general
--   or a DM).
-- - project_space_members: the people in a channel (#general and DMs have no rows).
-- - project_space_links: a channel's links, added or collected from messages,
--   with the server-fetched title and icon.
-- - project_user_marks: one-time onboarding marks a member leaves in a project.
-- - memory_thread_loads: the memory files a thread's first turn was listed.
--
-- project_sessions.space_id is a new nullable column: every existing row is
-- null and satisfies the FK, which is added NOT VALID (no scan under the
-- ACCESS EXCLUSIVE lock) and validated by 20261025190616832.
-- idx_project_sessions_space is built CONCURRENTLY by 20261025190616829.
-- The FKs from project_space_links and memory_thread_loads to
-- project_sessions take a brief SHARE ROW EXCLUSIVE lock on it (bounded by
-- lock_timeout) and check no rows: both new tables are empty.

CREATE TYPE "kortix"."project_space_kind" AS ENUM('channel', 'dm');--> statement-breakpoint
CREATE TYPE "kortix"."project_space_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TABLE "kortix"."memory_thread_loads" (
	"session_id" text PRIMARY KEY NOT NULL,
	"first_loaded_at" timestamp with time zone NOT NULL,
	"layers" jsonb NOT NULL
);--> statement-breakpoint
CREATE TABLE "kortix"."project_space_links" (
	"link_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"space_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pinned" boolean DEFAULT true NOT NULL,
	"pinned_by" uuid,
	"pinned_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"session_id" text,
	"last_shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fetched_title" text,
	"site_name" text,
	"icon_url" text,
	"fetched_at" timestamp with time zone,
	"fetch_failed_at" timestamp with time zone,
	CONSTRAINT "project_space_links_source_check" CHECK ("kortix"."project_space_links"."source" in ('manual', 'message'))
);--> statement-breakpoint
CREATE TABLE "kortix"."project_space_members" (
	"space_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_by" uuid,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id")
);--> statement-breakpoint
CREATE TABLE "kortix"."project_spaces" (
	"space_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "kortix"."project_space_kind" NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"dm_user_id" uuid,
	"dm_agent_name" text,
	"agents" text[] DEFAULT '{}'::text[] NOT NULL,
	"visibility" "kortix"."project_space_visibility" DEFAULT 'public' NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_spaces_kind_shape_check" CHECK (("kortix"."project_spaces"."kind" = 'channel' and "kortix"."project_spaces"."slug" is not null and "kortix"."project_spaces"."dm_user_id" is null and "kortix"."project_spaces"."dm_agent_name" is null) or ("kortix"."project_spaces"."kind" = 'dm' and "kortix"."project_spaces"."slug" is null and "kortix"."project_spaces"."dm_user_id" is not null and "kortix"."project_spaces"."dm_agent_name" is not null)),
	CONSTRAINT "project_spaces_private_channel_check" CHECK ("kortix"."project_spaces"."visibility" = 'public' or ("kortix"."project_spaces"."kind" = 'channel' and not "kortix"."project_spaces"."is_default"))
);--> statement-breakpoint
CREATE TABLE "kortix"."project_user_marks" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mark" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_user_marks_project_id_user_id_mark_pk" PRIMARY KEY("project_id","user_id","mark")
);--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD CONSTRAINT "project_space_links_space_id_project_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD CONSTRAINT "project_space_links_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_members" ADD CONSTRAINT "project_space_members_space_id_project_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ADD CONSTRAINT "project_spaces_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ADD CONSTRAINT "project_spaces_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_user_marks" ADD CONSTRAINT "project_user_marks_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_space_links_space_url" ON "kortix"."project_space_links" USING btree ("space_id","url");--> statement-breakpoint
CREATE INDEX "idx_project_space_links_space" ON "kortix"."project_space_links" USING btree ("space_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_project_space_links_session" ON "kortix"."project_space_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_project_space_links_project" ON "kortix"."project_space_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_space_members_user" ON "kortix"."project_space_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_channel_slug" ON "kortix"."project_spaces" USING btree ("project_id","slug") WHERE "kortix"."project_spaces"."kind" = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_dm" ON "kortix"."project_spaces" USING btree ("project_id","dm_user_id","dm_agent_name") WHERE "kortix"."project_spaces"."kind" = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_spaces_default" ON "kortix"."project_spaces" USING btree ("project_id") WHERE "kortix"."project_spaces"."is_default";--> statement-breakpoint
CREATE INDEX "idx_project_spaces_project" ON "kortix"."project_spaces" USING btree ("project_id");--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD COLUMN "space_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."project_sessions" ADD CONSTRAINT "project_sessions_space_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "kortix"."project_space_links" ADD CONSTRAINT "project_space_links_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- squawk-ignore adding-foreign-key-constraint, constraint-missing-not-valid
ALTER TABLE "kortix"."memory_thread_loads" ADD CONSTRAINT "memory_thread_loads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_spaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."project_user_marks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."memory_thread_loads" ENABLE ROW LEVEL SECURITY;
