-- Migration: sign_in_with_kortix_oauth
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

CREATE TABLE "kortix"."oauth_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id_hash" varchar(128) NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" varchar(10) DEFAULT 'S256' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kortix"."oauth_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "account_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "client_type" varchar(16) DEFAULT 'confidential' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_authorization_requests" ADD CONSTRAINT "oauth_auth_requests_client_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_consents" ADD CONSTRAINT "oauth_consents_client_fk" FOREIGN KEY ("client_id") REFERENCES "kortix"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_auth_requests_hash" ON "kortix"."oauth_authorization_requests" USING btree ("request_id_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_auth_requests_expires" ON "kortix"."oauth_authorization_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_oauth_consents_user_client" ON "kortix"."oauth_consents" USING btree ("user_id","client_id");--> statement-breakpoint
-- `oauth_clients` already exists (populated by hand on prod). The new FK is
-- added NOT VALID so the ADD never scans under the ACCESS EXCLUSIVE lock. The
-- column is brand new and all-NULL, so the VALIDATE (in the sibling
-- .concurrent.ts migration, its own transaction) has nothing to check. The
-- account_id index is built CONCURRENTLY there too.
ALTER TABLE "kortix"."oauth_clients" ADD CONSTRAINT "oauth_clients_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action NOT VALID;