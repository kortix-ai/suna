-- Migration: free_credits_once_per_person
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
-- Idempotent on purpose: this migration was re-dated on the workspaces branch
-- (173737521 -> 192403865 -> 203700000 -> 153000000) to sort after dev. A local
-- database that applied an earlier name records the same objects under that
-- name; IF NOT EXISTS lets the new name apply there as a no-op. ENABLE ROW
-- LEVEL SECURITY is a no-op when RLS is already on.
--
-- What: one free monthly grant per PERSON, not per account. A new table
-- kortix.free_credit_claims (user_id primary key) records the account that got
-- a person's free credits; credit_accounts.free_credits_eligible (default
-- true) marks the accounts that may receive them.
-- Lock: CREATE TABLE takes no lock on existing tables. ADD COLUMN with a
-- constant default is a catalog-only change on Postgres 11+ (no rewrite); it
-- takes ACCESS EXCLUSIVE on credit_accounts for milliseconds, bounded by
-- lock_timeout 2s.
-- Mixed-version deploy: the old image never reads either object.
-- ROLL BACK: no down migration (repo policy). Both objects are additive. A
-- forward migration drops credit_accounts.free_credits_eligible and
-- kortix.free_credit_claims; the old image keeps working with them present.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEWED (2026-11-06): the generated SQL below, against the list
-- `migrate:create` prints:
--   [x] No bare NOT NULL on a populated table: free_credits_eligible has a
--       constant default, so existing rows read true with no backfill.
--   [x] No plain CREATE/DROP INDEX on an existing table.
--   [x] No new FK or constraint on an existing table.
--   [x] No DROP/RENAME/ALTER ... TYPE from a stale snapshot.
--   [x] No ALTER TYPE ... ADD VALUE.

CREATE TABLE IF NOT EXISTS "kortix"."free_credit_claims" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."free_credit_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN IF NOT EXISTS "free_credits_eligible" boolean DEFAULT true NOT NULL;