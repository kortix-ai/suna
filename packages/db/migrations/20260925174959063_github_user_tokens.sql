-- Migration: github_user_tokens
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

CREATE TABLE "kortix"."account_github_user_tokens" (
	"token_row_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"github_login" varchar(255) NOT NULL,
	"value_enc" text NOT NULL,
	"refresh_value_enc" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."account_github_user_tokens" ADD CONSTRAINT "account_github_user_tokens_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_account_github_user_tokens_account_user" ON "kortix"."account_github_user_tokens" USING btree ("account_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_account_github_user_tokens_account" ON "kortix"."account_github_user_tokens" USING btree ("account_id");
-- drizzle-kit also proposed uniq_account_github_installations_owner here. It is
-- already built CONCURRENTLY by
-- 20260925164209388_github_installations_one_per_owner_index (the table is live;
-- a plain CREATE INDEX would block its writers). Removed on purpose — the
-- snapshot carries it, so it is not proposed again.

-- Both indexes above are on a table created in this same migration, so they take
-- no lock anyone can see and need no CONCURRENTLY escape hatch.