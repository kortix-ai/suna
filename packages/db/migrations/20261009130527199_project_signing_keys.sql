-- Migration: project_signing_keys
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- One sign-in issuer per project (`<public API origin>/v1/projects/<id>`).
--
-- 1. `project_signing_keys`: the ES256 key that signs a project's Kortix
--    sign-in tokens, one row per project, created on first use. A new empty
--    table; its FK takes a brief SHARE ROW EXCLUSIVE lock on `projects`.
-- 2. `app_convex_instances.auth_key_enc`: the per-App key is replaced by the
--    project key. Maintenance rewrites each convex App's KORTIX_AUTH_*
--    environment to the project issuer (auth_issuer tracks what it trusts).
--
-- mixed-version-safe: app_convex_instances was created by
-- 20261009115630597_apps_kinds in the same release, and no deployed code reads
-- it: the code before this release reads project_backends, which
-- 20261009115639481 drops. The column is dropped before any code that reads
-- it ships.

CREATE TABLE "kortix"."project_signing_keys" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"kid" text NOT NULL,
	"private_key_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_signing_keys" ADD CONSTRAINT "project_signing_keys_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- squawk-ignore ban-drop-column
ALTER TABLE "kortix"."app_convex_instances" DROP COLUMN "auth_key_enc";