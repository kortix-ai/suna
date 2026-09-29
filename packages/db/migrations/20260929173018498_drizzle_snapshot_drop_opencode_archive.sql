-- Snapshot companion for 20260929152656168_legacy_sandbox_migrations_drop_opencode_archive.sql.
--
-- That migration drops `legacy_sandbox_migrations.opencode_archive`, but
-- kortix.ts and the drizzle snapshot still declared the column, so the
-- "Applies cleanly to a fresh DB" contract check failed ("declared column
-- does not exist"). kortix.ts no longer declares it. This file exists only so
-- `packages/db/drizzle/` records the same shape.
--
-- The generated `ALTER TABLE ... DROP COLUMN "opencode_archive";` was REMOVED
-- on purpose, per the generator's checklist ("Delete anything already applied
-- by an earlier migration"): the sibling migration already dropped the column.
--
-- mixed-version-safe: no schema change here at all; the column removal is the
-- sibling migration's, and no application code reads the column.

set lock_timeout = '2s';
set statement_timeout = '30s';
