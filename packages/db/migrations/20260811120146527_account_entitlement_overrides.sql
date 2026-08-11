-- Migration: account_entitlement_overrides
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

-- ADDITIVE ONLY, and deliberately so. `entitlement_overrides` is the new home
-- for per-account overrides (each entry carries an optional `expires_at`), but
-- the four legacy override columns are NOT dropped and NOT stopped being
-- written: an API task from the previous release neither reads nor writes this
-- column, and a task from this release still writes both representations. The
-- contract removal is a separate, later migration.
ALTER TABLE "kortix"."credit_accounts" ADD COLUMN "entitlement_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN "kortix"."credit_accounts"."entitlement_overrides" IS
  'Per-account entitlement overrides: {"<key>":{"value":<boolean|number>,"expires_at"?:"<ISO 8601>"}}. Parsed by billing/services/entitlement-overrides.ts; a key here takes precedence over the matching legacy column, and an entry past its expires_at is ignored.';

-- Backfill every row that already carries an operator-set override, so the new
-- column is the complete picture from the first read instead of only covering
-- overrides set after this deploy. None of the backfilled entries gets an
-- `expires_at` — a legacy column override never expired, and inventing an
-- expiry here would silently revoke a contracted entitlement.
--
-- "Set" per column: the two booleans are NOT NULL DEFAULT false, so only `true`
-- is an override; the other two are nullable tri-states, so any non-NULL value
-- is one (managed_models_override = false means "BYOK only", which must be
-- carried across).
--
-- Idempotent: re-running rebuilds the same object from the same columns.
--
-- backfill-safe: kortix.credit_accounts — 12 rows updated out of 231,564 in
-- prod (measured 2026-08-11: `select count(*) filter (where
-- enterprise_entitled or demo_enterprise or managed_models_override is not null
-- or max_concurrent_sessions is not null)` = 12; dev = 58 of 2,620). The
-- statement is one unindexed predicate scan of the whole table plus 12 row
-- writes: `explain (analyze, buffers)` of the same predicate on prod ran in
-- 90 ms (parallel seq scan, 17,729 shared buffers, all cache hits). The
-- preceding ADD COLUMN takes a non-volatile default, so it is catalog-only and
-- rewrites nothing; the ACCESS EXCLUSIVE window it opens is therefore extended
-- by ~0.1 s of scan, not by a 30.5M-row rewrite (the centralized_audit_v2
-- shape). credit_accounts writers are billing webhooks and admin overrides at
-- single-digit writes per second, so a sub-second queue drains immediately.
UPDATE "kortix"."credit_accounts"
SET "entitlement_overrides" =
  CASE WHEN "enterprise_entitled"
    THEN jsonb_build_object('enterpriseEntitled', jsonb_build_object('value', true))
    ELSE '{}'::jsonb END
  || CASE WHEN "demo_enterprise"
    THEN jsonb_build_object('demoEnterprise', jsonb_build_object('value', true))
    ELSE '{}'::jsonb END
  || CASE WHEN "managed_models_override" IS NOT NULL
    THEN jsonb_build_object('managedModelsOverride', jsonb_build_object('value', "managed_models_override"))
    ELSE '{}'::jsonb END
  || CASE WHEN "max_concurrent_sessions" IS NOT NULL
    THEN jsonb_build_object('maxConcurrentSessions', jsonb_build_object('value', "max_concurrent_sessions"))
    ELSE '{}'::jsonb END
WHERE "enterprise_entitled"
   OR "demo_enterprise"
   OR "managed_models_override" IS NOT NULL
   OR "max_concurrent_sessions" IS NOT NULL;