-- Migration: apps_static_hosting
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

CREATE TABLE "kortix"."app_site_blobs" (
	"account_id" uuid NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_site_blobs_account_id_sha256_pk" PRIMARY KEY("account_id","sha256")
);
--> statement-breakpoint
CREATE TABLE "kortix"."app_site_files" (
	"deployment_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"path" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	CONSTRAINT "app_site_files_deployment_id_path_pk" PRIMARY KEY("deployment_id","path")
);
--> statement-breakpoint
-- mixed-version-safe: the check is widened from ('sandbox') to ('sandbox', 'static'). Old code writes only 'sandbox', which both versions accept; new code writes 'static' only after this migration ran (migrations land before code).
ALTER TABLE "kortix"."app_deployments" DROP CONSTRAINT "app_deployments_hosting_type_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_site_files" ADD CONSTRAINT "app_site_files_deployment_id_app_deployments_deployment_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "kortix"."app_deployments"("deployment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_site_blobs_created_idx" ON "kortix"."app_site_blobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_site_files_blob_idx" ON "kortix"."app_site_files" USING btree ("account_id","sha256");--> statement-breakpoint
-- NOT VALID and never validated, on purpose: the dropped check (= 'sandbox')
-- already guaranteed every existing row satisfies the wider one, and a NOT
-- VALID check is still enforced on every new write. Validating would only scan
-- app_deployments under lock to prove what the old constraint proved.
ALTER TABLE "kortix"."app_deployments" ADD CONSTRAINT "app_deployments_hosting_type_check" CHECK ("kortix"."app_deployments"."hosting_type" IN ('sandbox', 'static')) NOT VALID;