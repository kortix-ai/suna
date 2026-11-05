-- Migration: session_asks
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

CREATE TABLE "kortix"."session_pending_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"surface_session_id" text,
	"request_id" text NOT NULL,
	"runtime_session_id" text,
	"tool" text NOT NULL,
	"permission" text NOT NULL,
	"patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"args" jsonb,
	"args_hash" text NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decided_by" uuid,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."session_pending_questions" ADD COLUMN "parkable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."session_pending_questions" ADD COLUMN "surface_session_id" text;--> statement-breakpoint
ALTER TABLE "kortix"."session_pending_questions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."session_pending_permissions" ADD CONSTRAINT "session_pending_permissions_session_fk" FOREIGN KEY ("session_id") REFERENCES "kortix"."project_sessions"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_pending_permissions_session_request_uniq" ON "kortix"."session_pending_permissions" USING btree ("session_id","request_id");--> statement-breakpoint
CREATE INDEX "session_pending_permissions_open_idx" ON "kortix"."session_pending_permissions" USING btree ("project_id") WHERE decided_at IS NULL;--> statement-breakpoint
CREATE INDEX "session_pending_permissions_approved_idx" ON "kortix"."session_pending_permissions" USING btree ("session_id","args_hash") WHERE consumed_at IS NULL AND decision IN ('once', 'always');