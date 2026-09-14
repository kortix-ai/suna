-- Snapshot companion for 20260909083000000_drop_dead_audit_events_index.concurrent.ts.
--
-- That migration drops `idx_audit_events_account_source_phase_time` with
-- DROP INDEX CONCURRENTLY, which cannot run inside a transaction. This file
-- exists only so `packages/db/drizzle/` records the same shape kortix.ts now
-- declares — without it the "Schema matches migrations" gate sees an index in
-- the snapshot that the schema no longer has.
--
-- The generated `DROP INDEX "kortix"."idx_audit_events_account_source_phase_time";`
-- was REMOVED on purpose, per the generator's own checklist ("Delete anything
-- already applied by an earlier migration"): it is a blocking drop, and by the
-- time this file runs the concurrent sibling has already removed the index, so
-- the statement would also fail on a fresh database.
--
-- mixed-version-safe: no schema change here at all; the index removal is the
-- sibling migration's, and no application code names that index.

set lock_timeout = '2s';
set statement_timeout = '30s';
