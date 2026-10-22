-- Snapshot companion for 20261006150000000_account_secret_cooldown_probe_at.sql.
--
-- That hand-written migration adds `kortix.account_secret_resources.cooldown_probe_at`
-- and kortix.ts declares it, but the drizzle snapshot was not regenerated, so the
-- "Schema matches migrations" gate failed on the v0.13.52 staging promotion.
-- This file exists only so `packages/db/drizzle/` records the shape kortix.ts
-- now declares.
--
-- The generated `ALTER TABLE ... ADD COLUMN "cooldown_probe_at"` was REMOVED on
-- purpose: the earlier migration already adds the column.
--
-- mixed-version-safe: no schema change here at all.

set lock_timeout = '2s';
set statement_timeout = '30s';
