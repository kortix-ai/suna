-- Migration: storage_charges
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
--
-- Reviewed: two new, empty tables for volume storage billing
-- (apps/api/src/billing/services/storage-charges.ts) and Kortix's own cost of
-- Platinum boxes no Kortix row owns (orphan-box-costs.ts). No backfill. The
-- only lock on a populated table is the brief FK validation lock on
-- accounts and projects, with no rows to scan. RLS on with no policy, and the
-- client roles revoked: only the API's privileged connection reads them.

CREATE TABLE "kortix"."provider_orphan_box_costs" (
	"feed" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"usage_day" date NOT NULL,
	"meter" text NOT NULL,
	"quantity" numeric(24, 6) DEFAULT '0' NOT NULL,
	"amount_micros" bigint DEFAULT 0 NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_orphan_box_costs_feed_sandbox_id_usage_day_meter_pk" PRIMARY KEY("feed","sandbox_id","usage_day","meter")
);
--> statement-breakpoint
CREATE TABLE "kortix"."storage_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"usage_day" date NOT NULL,
	"account_id" uuid,
	"project_id" uuid,
	"session_id" text,
	"drive_id" uuid,
	"volume_name" text,
	"unattributed_reason" text,
	"waived" boolean DEFAULT false NOT NULL,
	"gib_hours" numeric(24, 10) DEFAULT '0' NOT NULL,
	"platinum_micros" bigint DEFAULT 0 NOT NULL,
	"charged_gib_hours" numeric(24, 10) DEFAULT '0' NOT NULL,
	"charged_usd" numeric(20, 10) DEFAULT '0' NOT NULL,
	"charge_seq" integer DEFAULT 0 NOT NULL,
	"pending_gib_hours" numeric(24, 10),
	"pending_usd" numeric(20, 10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_charges_kind" CHECK ("kortix"."storage_charges"."resource_kind" in ('volume', 'volume_snapshot', 'scratch')),
	CONSTRAINT "storage_charges_reason" CHECK ("kortix"."storage_charges"."unattributed_reason" is null or "kortix"."storage_charges"."unattributed_reason" in ('not_kortix', 'volume_gone', 'owner_gone', 'unsupported_kind'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD CONSTRAINT "storage_charges_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ADD CONSTRAINT "storage_charges_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_provider_orphan_box_costs_day" ON "kortix"."provider_orphan_box_costs" USING btree ("usage_day");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_charges_resource_day" ON "kortix"."storage_charges" USING btree ("feed","resource_kind","resource_id","usage_day");--> statement-breakpoint
CREATE INDEX "idx_storage_charges_account_day" ON "kortix"."storage_charges" USING btree ("account_id","usage_day");--> statement-breakpoint
CREATE INDEX "idx_storage_charges_project_day" ON "kortix"."storage_charges" USING btree ("project_id","usage_day");--> statement-breakpoint
ALTER TABLE "kortix"."storage_charges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."provider_orphan_box_costs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON kortix.storage_charges FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON kortix.provider_orphan_box_costs FROM anon, authenticated;
