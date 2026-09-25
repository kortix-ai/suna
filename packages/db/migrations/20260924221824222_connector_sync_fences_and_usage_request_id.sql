-- Migration: connector_sync_fences_and_usage_request_id
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

CREATE TABLE IF NOT EXISTS "kortix"."connector_sync_fences" (
	"project_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "connector_sync_fences_project_id_scope_pk" PRIMARY KEY("project_id","scope")
);
--> statement-breakpoint
-- Nullable, no default: a catalog-only change, no table rewrite. Old code never
-- writes it; its unique index is built CONCURRENTLY in the next migration.
ALTER TABLE "kortix"."usage_events" ADD COLUMN IF NOT EXISTS "request_id" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "kortix"."connector_sync_fences" ADD CONSTRAINT "connector_sync_fences_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
