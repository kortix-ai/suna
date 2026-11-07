-- Migration: credit_codes
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

-- Reviewed: two new, empty tables (credit codes and their redemptions,
-- apps/api/src/billing/services/credit-codes.ts). No change to an existing
-- table and no backfill. The indexes are on the new, empty tables, so plain
-- CREATE INDEX blocks nothing. The FK to kortix.accounts validates against
-- zero rows under a brief lock. RLS on with no policy, and the client roles
-- revoked: only the API's privileged connection reads or writes them.

CREATE TABLE "kortix"."credit_code_redemptions" (
	"redemption_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"redeemed_by" uuid,
	"amount_usd" numeric(12, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."credit_code_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kortix"."credit_codes" (
	"code_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"amount_usd" numeric(12, 2) NOT NULL,
	"max_redemptions" integer,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_codes_amount_positive" CHECK ("kortix"."credit_codes"."amount_usd" > 0),
	CONSTRAINT "credit_codes_max_redemptions_positive" CHECK ("kortix"."credit_codes"."max_redemptions" IS NULL OR "kortix"."credit_codes"."max_redemptions" > 0),
	CONSTRAINT "credit_codes_code_shape" CHECK ("kortix"."credit_codes"."code" ~ '^[A-Z0-9_-]{3,64}$')
);
--> statement-breakpoint
ALTER TABLE "kortix"."credit_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_code_id_credit_codes_code_id_fk" FOREIGN KEY ("code_id") REFERENCES "kortix"."credit_codes"("code_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."credit_code_redemptions" ADD CONSTRAINT "credit_code_redemptions_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_credit_code_redemptions_code_account" ON "kortix"."credit_code_redemptions" USING btree ("code_id","account_id");--> statement-breakpoint
CREATE INDEX "idx_credit_code_redemptions_account" ON "kortix"."credit_code_redemptions" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_credit_codes_code" ON "kortix"."credit_codes" USING btree ("code");--> statement-breakpoint
REVOKE ALL ON kortix.credit_codes FROM anon, authenticated;--> statement-breakpoint
REVOKE ALL ON kortix.credit_code_redemptions FROM anon, authenticated;
