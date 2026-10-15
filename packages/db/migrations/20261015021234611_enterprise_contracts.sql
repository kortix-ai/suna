-- Migration: enterprise_contracts
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

-- IF NOT EXISTS: this file was first committed as 20261015003246449 on the
-- enterprise-plans branch; a local database that ran that name already has
-- the table. No shared environment ever ran it.
CREATE TABLE IF NOT EXISTS "kortix"."enterprise_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"license_usd" numeric(12, 2) NOT NULL,
	"credits_usd" numeric(12, 2) NOT NULL,
	"term_months" integer DEFAULT 12 NOT NULL,
	"collection" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"stripe_subscription_id" text,
	"stripe_checkout_session_id" text,
	"auto_renews" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "enterprise_contracts_status_check" CHECK (status IN ('offered', 'active', 'ended', 'withdrawn')),
	CONSTRAINT "enterprise_contracts_collection_check" CHECK (collection IN ('checkout', 'invoice', 'manual'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enterprise_contracts_account" ON "kortix"."enterprise_contracts" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_enterprise_contracts_one_active" ON "kortix"."enterprise_contracts" USING btree ("account_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_enterprise_contracts_one_offered" ON "kortix"."enterprise_contracts" USING btree ("account_id") WHERE status = 'offered';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_enterprise_contracts_stripe_subscription" ON "kortix"."enterprise_contracts" USING btree ("stripe_subscription_id");--> statement-breakpoint

-- Hand-edited below (pattern from 20261014160044884_config_release_heads.sql):
-- contract amounts are billing data, closed to the browser roles.
REVOKE ALL ON TABLE "kortix"."enterprise_contracts" FROM anon;--> statement-breakpoint
REVOKE ALL ON TABLE "kortix"."enterprise_contracts" FROM authenticated;--> statement-breakpoint

-- RLS with no policy denies every row to every non-owner role if a later
-- blanket GRANT re-adds a privilege. ENABLE, deliberately not FORCE (see
-- 20260811140504477_impersonation_grants_lock_down).
ALTER TABLE "kortix"."enterprise_contracts" ENABLE ROW LEVEL SECURITY;
