-- Migration: sync_project_secret_tombstones
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Snapshot reconciliation for KRTX-2056 (schema-sync): kortix.ts declares
-- project_secret_tombstones, whose migration 20261010041538875 was written by
-- hand, so drizzle's snapshot never recorded the table and `drizzle-kit
-- generate` produced a diff on the next push to dev. This migration commits
-- the generated reconciliation. It must be a no-op on every database that
-- already ran 20261010041538875 (dev has): the table exists there, with the
-- FK added inline under Postgres's auto name. Hence IF NOT EXISTS for the
-- table, and a guard for the FK that accepts the auto-named one the original
-- migration created (same shape: references kortix.projects, ON DELETE
-- CASCADE) — a fresh database builds that shape from the original migration,
-- so neither path ends up with a duplicate constraint.

CREATE TABLE IF NOT EXISTS "kortix"."project_secret_tombstones" (
	"project_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secret_tombstones_project_id_name_pk" PRIMARY KEY("project_id","name")
);
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conrelid = '"kortix"."project_secret_tombstones"'::regclass
			AND contype = 'f'
			AND confrelid = '"kortix"."projects"'::regclass
			AND pg_get_constraintdef(oid) ILIKE '%FOREIGN KEY (project_id)%REFERENCES kortix.projects(project_id)%ON DELETE CASCADE%'
	) THEN
		ALTER TABLE "kortix"."project_secret_tombstones"
			ADD CONSTRAINT "project_secret_tombstones_project_id_projects_project_id_fk"
			FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;
	END IF;
END
$$;
