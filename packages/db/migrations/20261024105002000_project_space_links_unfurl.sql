-- Migration: project_space_links_unfurl
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- A channel link's title, site name and icon, fetched by the server in the
-- background (job `link-unfurl`), plus the fetch clock: `fetched_at` (fetched
-- again after 7 days) and `fetch_failed_at` (no new try for 24 hours).
-- Five nullable columns with no default: a catalog-only change, no table
-- rewrite and no backfill. Old code never names them, so it keeps working.
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "fetched_title" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "site_name" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "icon_url" text;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "kortix"."project_space_links" ADD COLUMN "fetch_failed_at" timestamp with time zone;
