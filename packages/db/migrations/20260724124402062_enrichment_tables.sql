-- Migration: enrichment_tables
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Domain-enrichment pipeline storage: a durable job queue (same
-- claim/lease/backoff shape as session_lifecycle_commands), a cross-request
-- profile cache keyed by normalized domain, and a per-URL page-markdown cache.
-- See apps/api/src/enrichment/* and packages/db/src/schema/kortix.ts.
--
-- Purely additive:
--   [x] New enum type (no existing table touched).
--   [x] Three new tables; all indexes created on the NEW tables in the same
--       transaction, so plain CREATE INDEX is safe (no CONCURRENTLY needed).
--   [x] FKs reference existing PKs only (accounts, projects), both cascading
--       so tenant/project deletion cleans up jobs.

CREATE TYPE "kortix"."enrichment_job_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead_lettered');

CREATE TABLE "kortix"."enrichment_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_by" uuid,
	"domain" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "kortix"."enrichment_job_status" DEFAULT 'queued' NOT NULL,
	"error_code" varchar(32),
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);

CREATE TABLE "kortix"."enrichment_page_cache" (
	"url_hash" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"markdown" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "kortix"."enrichment_profiles" (
	"domain" text PRIMARY KEY NOT NULL,
	"profile" jsonb NOT NULL,
	"crawl_status" varchar(16) DEFAULT 'complete' NOT NULL,
	"model" text,
	"crawled_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "kortix"."enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_account_id_accounts_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "kortix"."accounts"("account_id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "kortix"."enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "kortix"."projects"("project_id") ON DELETE cascade ON UPDATE no action;

-- Partial unique: only one LIVE (queued/running) job per project+domain;
-- terminal rows keep their key so history never blocks resubmission.
CREATE UNIQUE INDEX "idx_enrichment_jobs_active_idempotency" ON "kortix"."enrichment_jobs" USING btree ("idempotency_key") WHERE "kortix"."enrichment_jobs"."status" in ('queued', 'running');
CREATE INDEX "idx_enrichment_jobs_due" ON "kortix"."enrichment_jobs" USING btree ("status","available_at");
CREATE INDEX "idx_enrichment_jobs_project" ON "kortix"."enrichment_jobs" USING btree ("project_id");
CREATE INDEX "idx_enrichment_jobs_account" ON "kortix"."enrichment_jobs" USING btree ("account_id");
CREATE INDEX "idx_enrichment_jobs_locked" ON "kortix"."enrichment_jobs" USING btree ("locked_until");
CREATE INDEX "idx_enrichment_page_cache_fetched" ON "kortix"."enrichment_page_cache" USING btree ("fetched_at");
