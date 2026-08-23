-- Migration: add_compute_node_device_auth
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

CREATE TABLE "kortix"."compute_node_device_auth_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" varchar(16) NOT NULL,
	"secret_hash" varchar(128) NOT NULL,
	"machine_hostname" varchar(255) NOT NULL,
	"node_type" text DEFAULT 'workstation' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account_id" uuid,
	"node_id" uuid,
	"encrypted_enrollment" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compute_node_device_auth_status_check" CHECK ("kortix"."compute_node_device_auth_requests"."status" IN ('pending', 'approved', 'denied')),
	CONSTRAINT "compute_node_device_auth_type_check" CHECK ("kortix"."compute_node_device_auth_requests"."node_type" IN ('workstation', 'vm', 'container', 'bare_metal', 'ci'))
);
--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_device_auth_requests" ADD CONSTRAINT "cn_device_auth_account_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kortix"."compute_node_device_auth_requests" ADD CONSTRAINT "cn_device_auth_node_fk" FOREIGN KEY ("node_id") REFERENCES "kortix"."compute_nodes"("node_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "compute_node_device_auth_code_unique" ON "kortix"."compute_node_device_auth_requests" USING btree ("device_code");--> statement-breakpoint
CREATE INDEX "compute_node_device_auth_expiry_idx" ON "kortix"."compute_node_device_auth_requests" USING btree ("expires_at");
