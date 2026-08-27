-- Migration: session_environments
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

CREATE TABLE "kortix"."session_environments" (
	"session_id" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider" "kortix"."sandbox_provider" DEFAULT 'daytona' NOT NULL,
	"external_id" text,
	"base_url" text,
	"status" "kortix"."session_sandbox_status" DEFAULT 'provisioning' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_session_environments_project" ON "kortix"."session_environments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_session_environments_account" ON "kortix"."session_environments" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_session_environments_status" ON "kortix"."session_environments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_session_environments_external_id" ON "kortix"."session_environments" USING btree ("external_id");