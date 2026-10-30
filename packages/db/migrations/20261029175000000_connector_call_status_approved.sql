-- Migration: connector_call_status_approved
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Additive: a connector approval gate that a person approved and whose held
-- call Kortix runs once, as the original caller. Old code never writes the
-- value; new code writes it only after this migration ran (deploys migrate
-- before the rollout). Own file: a new enum value cannot be used in the
-- transaction that adds it.
-- enum-value-checked: a new value that no environment can hold yet, so no faked or rebaselined baseline skipped it; every env gets it from this file through `pnpm --filter @kortix/db migrate`, and IF NOT EXISTS makes a re-run a no-op.
ALTER TYPE "kortix"."connector_call_status" ADD VALUE IF NOT EXISTS 'approved';
