-- Migration: trigger_event_polls
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

CREATE TABLE "kortix"."project_trigger_event_polls" (
	"external_id" text PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connector_slug" varchar(128) NOT NULL,
	"event_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_seconds" integer NOT NULL,
	"seen" text[] DEFAULT '{}'::text[] NOT NULL,
	"primed_at" timestamp with time zone,
	"next_poll_at" timestamp with time zone,
	"locked_until" timestamp with time zone,
	"claim" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_error_kind" text,
	"rate_window_start" timestamp with time zone,
	"rate_window_fires" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_trigger_event_polls_interval_check" CHECK ("kortix"."project_trigger_event_polls"."interval_seconds" between 60 and 86400),
	CONSTRAINT "project_trigger_event_polls_error_kind_check" CHECK ("kortix"."project_trigger_event_polls"."last_error_kind" is null or "kortix"."project_trigger_event_polls"."last_error_kind" in ('needs_connection', 'fatal', 'transient'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_event_polls" ADD CONSTRAINT "project_trigger_event_polls_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_trigger_event_polls_due" ON "kortix"."project_trigger_event_polls" USING btree ("next_poll_at") WHERE "kortix"."project_trigger_event_polls"."next_poll_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_project_trigger_event_polls_project" ON "kortix"."project_trigger_event_polls" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_project_trigger_event_polls_connection" ON "kortix"."project_trigger_event_polls" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_event_polls" ENABLE ROW LEVEL SECURITY;
