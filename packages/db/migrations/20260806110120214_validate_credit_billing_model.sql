-- Migration: validate_credit_billing_model
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
-- VALIDATE takes a full scan of credit_accounts. It holds only SHARE UPDATE
-- EXCLUSIVE (reads and writes continue), so the generous ceiling buys the scan
-- room without blocking traffic.
set statement_timeout = '5min';

-- Completes 20260806110120042_allow_credit_billing_model.sql. That migration
-- added the widened constraint NOT VALID to keep the swap off the hot path;
-- this proves the existing rows against it.
--
-- Cannot fail on real data: the new constraint is a strict superset of the old
-- one, and the old one was already enforced for every row.
alter table "kortix"."credit_accounts"
  validate constraint "kortix_credit_accounts_billing_model_check";
