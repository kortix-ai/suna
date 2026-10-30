-- Migration: drives_volume_region
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

ALTER TABLE "kortix"."drives" ADD COLUMN "platinum_volume_region" text;--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD COLUMN "platinum_volume_move" jsonb;--> statement-breakpoint
ALTER TABLE "kortix"."platinum_volume_deletions" ADD COLUMN "region" text;--> statement-breakpoint
-- A drive's volume lives in one Platinum region, and only that region's
-- control plane can delete it: the queue carries the region. A drive that
-- moved region still holds its old volume until the retention purge; a delete
-- of the drive queues that one too.
CREATE OR REPLACE FUNCTION kortix.queue_drive_volume_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kortix.platinum_volume_deletions (volume_name, region, reason)
  VALUES (OLD.platinum_volume_name, OLD.platinum_volume_region, 'drive_deleted')
  ON CONFLICT (volume_name) DO NOTHING;
  IF OLD.platinum_volume_move IS NOT NULL
     AND OLD.platinum_volume_move ->> 'purged_at' IS NULL
     AND coalesce(OLD.platinum_volume_move ->> 'from_name', '') <> ''
     AND OLD.platinum_volume_move ->> 'from_name' <> OLD.platinum_volume_name THEN
    INSERT INTO kortix.platinum_volume_deletions (volume_name, region, reason)
    VALUES (OLD.platinum_volume_move ->> 'from_name', OLD.platinum_volume_move ->> 'from_region', 'drive_deleted')
    ON CONFLICT (volume_name) DO NOTHING;
  END IF;
  RETURN OLD;
END
$$;
