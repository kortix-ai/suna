-- Migration: audit_activity_daily
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

CREATE TABLE "kortix"."audit_activity_daily" (
	"account_id" uuid NOT NULL,
	"day" date NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"credential_kind" text NOT NULL,
	"client" text NOT NULL,
	"events" integer NOT NULL,
	"hours_mask" integer NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_activity_daily_pkey" PRIMARY KEY("account_id","day","project_id","actor_user_id","actor_type","credential_kind","client")
);
--> statement-breakpoint
CREATE TABLE "kortix"."audit_activity_rollup" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"rolled_through" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_activity_rollup_single_row" CHECK ("kortix"."audit_activity_rollup"."id" = 1)
);
--> statement-breakpoint
CREATE INDEX "idx_audit_activity_daily_project_day" ON "kortix"."audit_activity_daily" USING btree ("account_id","project_id","day");