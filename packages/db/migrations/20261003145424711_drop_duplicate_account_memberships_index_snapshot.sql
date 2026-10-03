-- Snapshot companion for 20261003020000100_drop_duplicate_account_memberships_index.concurrent.ts.
--
-- That migration drops `kortix.idx_account_members_user_account` with
-- DROP INDEX CONCURRENTLY, which cannot run inside a transaction. This file
-- exists only so `packages/db/drizzle/` records the same shape kortix.ts now
-- declares — without it the "Schema matches migrations" gate sees an index in
-- the snapshot that the schema no longer has.
--
-- The generated `DROP INDEX "kortix"."idx_account_members_user_account";` was
-- REMOVED on purpose: it is a blocking drop, and by the time this file runs the
-- concurrent sibling has already removed the index.
--
-- mixed-version-safe: no schema change here at all.

set lock_timeout = '2s';
set statement_timeout = '30s';
