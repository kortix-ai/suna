-- Snapshot companion for 20261010041538875_project_secret_tombstones.sql.
--
-- That hand-written migration creates `kortix.project_secret_tombstones` and
-- kortix.ts declares it (#9484), but the drizzle snapshot was not regenerated,
-- so the "Schema matches migrations" gate failed on the staging promotion
-- #9512 and on every dev push since. This file exists only so
-- `packages/db/drizzle/` records the shape kortix.ts now declares.
--
-- The generated `CREATE TABLE "kortix"."project_secret_tombstones"` and its
-- `ADD CONSTRAINT ... FOREIGN KEY` were REMOVED on purpose: the earlier
-- migration already creates the table, its primary key and the cascade FK.
--
-- mixed-version-safe: no schema change here at all.

set lock_timeout = '2s';
set statement_timeout = '30s';
