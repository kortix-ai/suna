-- Snapshot companion for 20261007112400000_project_backends.sql and
-- 20261007112400002_backend_auth_key.sql.
--
-- Those migrations create `kortix.project_backends` (with `auth_key_enc`). The
-- branch that added them and `dev` each generated drizzle snapshots, so the
-- merge kept dev's chain and this file records the merged shape kortix.ts now
-- declares in `packages/db/drizzle/`.
--
-- The generated CREATE TABLE / ADD CONSTRAINT / CREATE INDEX were REMOVED on
-- purpose: the two migrations above already apply them.
--
-- mixed-version-safe: no schema change here at all.
set lock_timeout = '2s';
set statement_timeout = '30s';
