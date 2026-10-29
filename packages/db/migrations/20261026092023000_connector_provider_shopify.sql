-- Migration: connector_provider_shopify
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Additive: the native Shopify connector (`provider: shopify`). Old code never
-- writes or reads the value; new code writes it only after this migration ran
-- (deploys migrate before the rollout).
-- enum-value-checked: a new value that no environment can hold yet, so no faked or rebaselined baseline skipped it; every env gets it from this file through `pnpm --filter @kortix/db migrate`, and IF NOT EXISTS makes a re-run a no-op.
ALTER TYPE "kortix"."connector_provider" ADD VALUE IF NOT EXISTS 'shopify';
