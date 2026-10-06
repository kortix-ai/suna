-- Snapshot companion for 20261006180000000_account_deletion_trigger_marks_for_sweep.sql.
--
-- That hand-written migration adds `kortix.account_deletion_requests.processing_started_at`
-- and kortix.ts declares it, but the drizzle snapshot was not regenerated, so the
-- "Schema matches migrations" gate failed on the v0.13.52 staging promotion.
-- This file exists only so `packages/db/drizzle/` records the shape kortix.ts
-- now declares.
--
-- The generated `ALTER TABLE ... ADD COLUMN "processing_started_at"` was REMOVED
-- on purpose: the earlier migration already adds the column.
--
-- mixed-version-safe: no schema change here at all.

set lock_timeout = '2s';
set statement_timeout = '30s';
