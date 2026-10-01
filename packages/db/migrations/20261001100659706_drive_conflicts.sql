-- Migration: drive_conflicts
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

CREATE TABLE "kortix"."drive_conflicts" (
	"conflict_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"drive_id" uuid NOT NULL,
	"path" text NOT NULL,
	"original_path" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid
);
--> statement-breakpoint
ALTER TABLE "kortix"."drives" ADD COLUMN "conflict_scan_head" text;--> statement-breakpoint
ALTER TABLE "kortix"."drive_conflicts" ADD CONSTRAINT "drive_conflicts_drive_id_drives_drive_id_fk" FOREIGN KEY ("drive_id") REFERENCES "kortix"."drives"("drive_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_conflicts_drive_path" ON "kortix"."drive_conflicts" USING btree ("drive_id","path");--> statement-breakpoint
CREATE INDEX "idx_drive_conflicts_open" ON "kortix"."drive_conflicts" USING btree ("drive_id") WHERE "kortix"."drive_conflicts"."resolved_at" is null and "kortix"."drive_conflicts"."dismissed_at" is null;--> statement-breakpoint
ALTER TABLE kortix.drive_conflicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON kortix.drive_conflicts FROM anon, authenticated;
