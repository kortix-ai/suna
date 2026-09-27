-- Migration: config_release_quarantine
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

CREATE TABLE "kortix"."config_release_failures" (
	"project_id" uuid NOT NULL,
	"release_id" varchar(64) NOT NULL,
	"session_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_release_failures_project_id_release_id_session_id_pk" PRIMARY KEY("project_id","release_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "kortix"."config_releases" (
	"project_id" uuid NOT NULL,
	"release_id" varchar(64) NOT NULL,
	"variant" varchar(255) NOT NULL,
	"source_commit" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"proven_at" timestamp with time zone,
	"proven_session_id" uuid,
	CONSTRAINT "config_releases_project_id_release_id_variant_pk" PRIMARY KEY("project_id","release_id","variant")
);
--> statement-breakpoint
ALTER TABLE "kortix"."config_release_failures" ADD CONSTRAINT "config_release_failures_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."config_releases" ADD CONSTRAINT "config_releases_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_config_releases_project_variant_created" ON "kortix"."config_releases" USING btree ("project_id","variant","created_at");--> statement-breakpoint
-- Server-only tables: the API writes them with the service role. Same
-- posture as prompt_attachments and pooled_provider_secrets.
ALTER TABLE "kortix"."config_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."config_release_failures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."config_releases", "kortix"."config_release_failures" FROM anon, authenticated;
