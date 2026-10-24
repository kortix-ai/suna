-- Migration: memory_pages
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

-- Memory pages (Channels Memory, P1): memory_layers -> memory_pages ->
-- memory_page_versions + memory_page_sources, plus memory_thread_loads.
-- Every table and enum here is new and empty: the plain CREATE INDEX and the
-- FKs (no NOT VALID) take no lock on a populated table. RLS on with no policy,
-- like kortix.project_space_links: API-only, only the owner role reads them.

CREATE TYPE "kortix"."memory_author_kind" AS ENUM('person', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "kortix"."memory_change_op" AS ENUM('create', 'update', 'append', 'delete', 'restore', 'undo', 'confirm', 'file_note', 'import');--> statement-breakpoint
CREATE TYPE "kortix"."memory_layer_scope" AS ENUM('company', 'channel', 'dm');--> statement-breakpoint
CREATE TYPE "kortix"."memory_page_status" AS ENUM('confirmed', 'unconfirmed');--> statement-breakpoint
CREATE TYPE "kortix"."memory_page_type" AS ENUM('people', 'decisions', 'workstreams', 'playbooks', 'note');--> statement-breakpoint
CREATE TYPE "kortix"."memory_source_kind" AS ENUM('thread', 'person', 'outside', 'import');--> statement-breakpoint
CREATE TABLE "kortix"."memory_layers" (
	"layer_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"scope" "kortix"."memory_layer_scope" NOT NULL,
	"space_id" uuid,
	"version" bigint DEFAULT 0 NOT NULL,
	"imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_layers_scope_space_check" CHECK (("kortix"."memory_layers"."scope" = 'company') = ("kortix"."memory_layers"."space_id" is null))
);
--> statement-breakpoint
CREATE TABLE "kortix"."memory_page_sources" (
	"source_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" "kortix"."memory_source_kind" NOT NULL,
	"session_id" text,
	"message_id" text,
	"label" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."memory_page_versions" (
	"version_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page_id" uuid NOT NULL,
	"layer_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"type" "kortix"."memory_page_type" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"status" "kortix"."memory_page_status" NOT NULL,
	"related" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"op" "kortix"."memory_change_op" NOT NULL,
	"author_kind" "kortix"."memory_author_kind" NOT NULL,
	"author_user_id" uuid,
	"author_agent" text,
	"on_behalf_user_id" uuid,
	"source_session_id" text,
	"source_message_id" text,
	"undone_by_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."memory_pages" (
	"page_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "kortix"."memory_page_type" NOT NULL,
	"title" text NOT NULL,
	"title_key" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" "kortix"."memory_page_status" DEFAULT 'confirmed' NOT NULL,
	"related" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"updated_by_kind" "kortix"."memory_author_kind",
	"updated_by_user_id" uuid,
	"updated_by_agent" text,
	"updated_source_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '') || ' ' || coalesce("summary", '') || ' ' || coalesce("body", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "kortix"."memory_thread_loads" (
	"session_id" text PRIMARY KEY NOT NULL,
	"first_loaded_at" timestamp with time zone NOT NULL,
	"layers" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."memory_layers" ADD CONSTRAINT "memory_layers_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_layers" ADD CONSTRAINT "memory_layers_space_id_project_spaces_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "kortix"."project_spaces"("space_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_sources" ADD CONSTRAINT "memory_page_sources_page_id_memory_pages_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "kortix"."memory_pages"("page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_sources" ADD CONSTRAINT "memory_page_sources_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_versions" ADD CONSTRAINT "memory_page_versions_page_id_memory_pages_page_id_fk" FOREIGN KEY ("page_id") REFERENCES "kortix"."memory_pages"("page_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_versions" ADD CONSTRAINT "memory_page_versions_layer_id_memory_layers_layer_id_fk" FOREIGN KEY ("layer_id") REFERENCES "kortix"."memory_layers"("layer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_versions" ADD CONSTRAINT "memory_page_versions_source_session_fk" FOREIGN KEY ("source_session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_pages" ADD CONSTRAINT "memory_pages_layer_id_memory_layers_layer_id_fk" FOREIGN KEY ("layer_id") REFERENCES "kortix"."memory_layers"("layer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_pages" ADD CONSTRAINT "memory_pages_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."memory_thread_loads" ADD CONSTRAINT "memory_thread_loads_session_id_project_sessions_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_layers_company" ON "kortix"."memory_layers" USING btree ("project_id") WHERE "kortix"."memory_layers"."scope" = 'company';--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_layers_space" ON "kortix"."memory_layers" USING btree ("space_id") WHERE "kortix"."memory_layers"."space_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_memory_layers_project" ON "kortix"."memory_layers" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_page_sources_page_number" ON "kortix"."memory_page_sources" USING btree ("page_id","number");--> statement-breakpoint
CREATE INDEX "idx_memory_page_sources_session" ON "kortix"."memory_page_sources" USING btree ("session_id") WHERE "kortix"."memory_page_sources"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_page_versions_page_no" ON "kortix"."memory_page_versions" USING btree ("page_id","version_no");--> statement-breakpoint
CREATE INDEX "idx_memory_page_versions_layer_created" ON "kortix"."memory_page_versions" USING btree ("layer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_memory_page_versions_session" ON "kortix"."memory_page_versions" USING btree ("source_session_id") WHERE "kortix"."memory_page_versions"."source_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_memory_pages_layer_title" ON "kortix"."memory_pages" USING btree ("layer_id","title_key") WHERE "kortix"."memory_pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_memory_pages_layer_type" ON "kortix"."memory_pages" USING btree ("layer_id","type","updated_at" DESC NULLS LAST) WHERE "kortix"."memory_pages"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "idx_memory_pages_layer" ON "kortix"."memory_pages" USING btree ("layer_id");--> statement-breakpoint
CREATE INDEX "idx_memory_pages_search" ON "kortix"."memory_pages" USING gin ("search");--> statement-breakpoint
CREATE INDEX "idx_memory_pages_project" ON "kortix"."memory_pages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_memory_pages_deleted" ON "kortix"."memory_pages" USING btree ("deleted_at") WHERE "kortix"."memory_pages"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "kortix"."memory_layers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."memory_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."memory_page_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."memory_thread_loads" ENABLE ROW LEVEL SECURITY;
