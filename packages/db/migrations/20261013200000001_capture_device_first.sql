-- Migration: capture_device_first
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

-- WHAT: Kortix Capture is device-first. A computer IT enrolled with a token
-- records before anyone links it to a Kortix user, so its device row and its
-- timeline rows carry no person (user_id NULL) until an admin links it; the
-- API then moves its unlinked rows to that person. DROP NOT NULL is a catalog
-- change: no rewrite, no scan. On the partitioned timeline tables it applies to
-- every partition.
-- mixed-version-safe: these tables ship with Capture and no deployed release has them yet (branch capture-platform is unmerged), so no older API reads them; the code that writes NULL ships in the same release.
--
-- ROLL BACK: no down migration (repo policy). Restoring NOT NULL needs every
-- row linked first.

ALTER TABLE "kortix"."capture_devices" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_actions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_audio" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_frames" ALTER COLUMN "user_id" DROP NOT NULL;