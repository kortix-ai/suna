-- Snapshot companion for 20261004045616326_drop_unused_account_invitations_indexes.concurrent.ts.
--
-- That migration drops `kortix.idx_account_invitations_email` and
-- `kortix.idx_account_invitations_account` with DROP INDEX CONCURRENTLY, which
-- cannot run inside a transaction. This file exists only so
-- `packages/db/drizzle/` records the same shape kortix.ts now declares —
-- without it the "Schema matches migrations" gate sees an index in the
-- snapshot that the schema no longer has.
--
-- The generated `DROP INDEX "kortix"."idx_account_invitations_email";` and
-- `DROP INDEX "kortix"."idx_account_invitations_account";` were REMOVED on
-- purpose: they are blocking drops, and by the time this file runs the
-- concurrent sibling has already removed both indexes.
--
-- mixed-version-safe: no schema change here at all.

set lock_timeout = '2s';
set statement_timeout = '30s';
