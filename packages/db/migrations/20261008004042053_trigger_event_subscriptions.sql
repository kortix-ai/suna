-- Migration: trigger_event_subscriptions
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

CREATE TABLE "kortix"."project_trigger_event_subscriptions" (
	"project_id" uuid NOT NULL,
	"slug" varchar(128) NOT NULL,
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"event_type" text NOT NULL,
	"external_id" text,
	"desired_hash" text NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_trigger_event_subscriptions_project_id_slug_pk" PRIMARY KEY("project_id","slug"),
	CONSTRAINT "project_trigger_event_subscriptions_status_check" CHECK ("kortix"."project_trigger_event_subscriptions"."status" in ('active', 'needs_connection', 'error'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_event_subscriptions" ADD CONSTRAINT "project_trigger_event_subscriptions_project_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_event_subscriptions" ADD CONSTRAINT "project_trigger_event_subscriptions_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "kortix"."connector_connections"("connection_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_trigger_event_subscriptions_external" ON "kortix"."project_trigger_event_subscriptions" USING btree ("provider","external_id") WHERE "kortix"."project_trigger_event_subscriptions"."external_id" is not null;
--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_event_subscriptions" ENABLE ROW LEVEL SECURITY;
