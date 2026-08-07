-- Migration: allow_credit_billing_model
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Billing v3: flat credit plans (Starter / Team / Scale). The plan carries the
-- monthly credit pool and the concurrency limit; headcount leaves the price.
-- `credit_accounts.billing_model` needs a third value so those accounts are
-- distinguishable from the grandfathered per-seat ones, whose behaviour is
-- unchanged.
--
-- WIDENING only: 'legacy' and 'per_seat' both stay valid, so every existing row
-- still satisfies the constraint and no backfill is needed. Added NOT VALID so
-- the swap takes no full-table scan under the ACCESS EXCLUSIVE lock;
-- 20260806110120214_validate_credit_billing_model.sql validates it.
--
-- mixed-version-safe: This only ADDS an accepted value. Old code writes solely
-- 'legacy'/'per_seat', which the replacement still permits, so a pre-deploy
-- instance cannot write a row the new constraint rejects. In the other
-- direction, an old instance reading a 'credit' row classifies it as legacy
-- (isLegacyAccount) and would skip compute metering for it -- under-billing,
-- never a crash and never a wrong charge. That window is empty in practice:
-- nothing can hold 'credit' until the v3 Stripe prices exist, and checkout
-- fails closed without them ("No price configured for this tier").
alter table "kortix"."credit_accounts"
  drop constraint if exists "kortix_credit_accounts_billing_model_check";

alter table "kortix"."credit_accounts"
  add constraint "kortix_credit_accounts_billing_model_check"
  check ("billing_model" = any (array['legacy'::text, 'per_seat'::text, 'credit'::text]))
  not valid;
