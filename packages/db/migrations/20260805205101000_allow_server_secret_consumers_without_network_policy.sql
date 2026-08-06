-- Migration: allow_server_secret_consumers_without_network_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: Old code supplies egress_policy for every broker row.
-- The replacement preserves that path and adds server-only consumers.
alter table "kortix"."project_secrets"
  drop constraint "project_secrets_egress_policy_required";

alter table "kortix"."project_secrets"
  add constraint "project_secrets_egress_policy_required"
  check (
    "strategy" in ('runtime', 'denied')
    or (
      "strategy" = 'broker'
      and "consumer" in ('llm_gateway', 'connector', 'executor', 'git_proxy')
    )
    or "egress_policy" is not null
  ) not valid;
