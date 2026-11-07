-- Migration: credit_accounts_comp_plan_until
--
-- Workspaces M9 (design: .agents/skills/learnings/work/workspaces/design.md §3.2 C6,
-- §3.3). A workspace split off a paying account gets the keeper's plan comped,
-- with no Stripe subscription, until this time. The billing rotation
-- (billing/services/split-off-billing.ts, expireSplitOffComps) moves the account
-- to Free with free-credit eligibility when it passes. NULL = no comp.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE on credit_accounts for a moment. 3s lock_timeout: on 55P03
-- the file rolls back as a whole: find the holder in pg_stat_activity, rerun
-- the migrate job. Never raise the timeout. IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names comp_plan_until. Every row
-- stays NULL until a split applies, which only the new image runs.
--
-- ROLL BACK: no down migration (repo policy). The column can stay: nothing but
-- the new image reads it.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."credit_accounts" ADD COLUMN IF NOT EXISTS "comp_plan_until" timestamptz;

COMMENT ON COLUMN "kortix"."credit_accounts"."comp_plan_until" IS
  'Split-off comp: the keeper''s plan is comped (no Stripe subscription) until this time. NULL = no comp.';
