-- Migration: allow_denied_secret_delivery_without_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: Existing code writes runtime rows. The replacement keeps
-- that path valid and only adds the fail-closed denied state.
alter table "kortix"."project_secrets"
  drop constraint "project_secrets_egress_policy_required";

alter table "kortix"."project_secrets"
  add constraint "project_secrets_egress_policy_required"
  check (
    "strategy" in ('runtime', 'denied')
    or "egress_policy" is not null
  ) not valid;
