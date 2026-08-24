-- Migration: add_compute_node_credentials
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

CREATE TABLE "kortix"."compute_node_credentials" (
	"credential_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"public_prefix" varchar(32) NOT NULL,
	"secret_hash" varchar(128) NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_node_credentials_status_check" CHECK ("kortix"."compute_node_credentials"."status" IN ('active', 'revoked')),
	CONSTRAINT "compute_node_credentials_generation_check" CHECK ("kortix"."compute_node_credentials"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "kortix"."compute_node_enrollment_tokens" (
	"enrollment_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"secret_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_credentials" ADD CONSTRAINT "compute_node_credentials_node_id_compute_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "kortix"."compute_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_credentials" ADD CONSTRAINT "compute_node_credentials_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_enrollment_tokens" ADD CONSTRAINT "compute_node_enrollment_tokens_node_id_compute_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "kortix"."compute_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_enrollment_tokens" ADD CONSTRAINT "compute_node_enrollment_account_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_node_credentials_hash_unique" ON "kortix"."compute_node_credentials" USING btree ("secret_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_node_credentials_generation_unique" ON "kortix"."compute_node_credentials" USING btree ("node_id","generation");--> statement-breakpoint
CREATE INDEX "compute_node_credentials_node_idx" ON "kortix"."compute_node_credentials" USING btree ("node_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_node_enrollment_tokens_hash_unique" ON "kortix"."compute_node_enrollment_tokens" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "compute_node_enrollment_tokens_node_idx" ON "kortix"."compute_node_enrollment_tokens" USING btree ("node_id","expires_at");
