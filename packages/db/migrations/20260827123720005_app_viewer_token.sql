-- Migration: app_viewer_token
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

ALTER TABLE "kortix"."apps" ADD COLUMN "viewer_token_scope" varchar(16) DEFAULT 'identity' NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."oauth_clients" ADD COLUMN "app_id" uuid;--> statement-breakpoint
-- Both tables already exist, so every constraint lands NOT VALID here and is
-- VALIDATEd in the sibling .concurrent.ts (its own transaction, no ACCESS
-- EXCLUSIVE scan under this file's lock). Both columns are brand new, so the
-- validation scans rows that cannot violate anything. The unique index on the
-- new all-NULL oauth_clients.app_id is built CONCURRENTLY there too.
ALTER TABLE "kortix"."oauth_clients" ADD CONSTRAINT "oauth_clients_app_id_apps_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "kortix"."apps" ADD CONSTRAINT "apps_viewer_token_scope_check" CHECK ("kortix"."apps"."viewer_token_scope" IN ('off', 'identity', 'api')) NOT VALID;