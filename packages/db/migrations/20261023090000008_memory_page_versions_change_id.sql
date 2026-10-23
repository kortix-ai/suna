-- Migration: memory_page_versions_change_id
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

-- memory_page_versions.change_id: one id shared by every version row one change
-- writes (both pages of a file_note), so one Undo restores all of them.
-- kortix.memory_page_versions was created empty by 20261023090000007 and no
-- code writes it yet, so it is still empty here: the bare NOT NULL column needs
-- no backfill, and the plain CREATE INDEX takes no lock on a populated table
-- (no .concurrent.ts needed).

-- The table is empty (see above): no existing row needs a value.
-- squawk-ignore adding-required-field
ALTER TABLE "kortix"."memory_page_versions" ADD COLUMN "change_id" uuid NOT NULL;--> statement-breakpoint
-- The table is empty (see above): the build blocks no real writes.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX "idx_memory_page_versions_change" ON "kortix"."memory_page_versions" USING btree ("change_id");
