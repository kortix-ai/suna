-- Migration: apps_image_builder_and_deleting
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
-- mixed-version-safe: the widened check accepts every status old code writes ('building', 'ready'); old code never reads builder_deployment_id. kortix.app_images ships in the same release as this migration, so no older build reads 'deleting'.
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- A release marks an image 'deleting' while it calls the provider delete
-- outside any transaction; claims wait on it. builder_deployment_id names the
-- one deployment that claimed the build (apps/images.ts claimAppImage).
ALTER TABLE "kortix"."app_images" DROP CONSTRAINT "app_images_status_check";--> statement-breakpoint
ALTER TABLE "kortix"."app_images" ADD COLUMN "builder_deployment_id" uuid;--> statement-breakpoint
ALTER TABLE "kortix"."app_images" ADD CONSTRAINT "app_images_status_check" CHECK ("kortix"."app_images"."status" IN ('building', 'ready', 'deleting')) NOT VALID;