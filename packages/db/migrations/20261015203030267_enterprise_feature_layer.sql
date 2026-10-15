-- Migration: enterprise_feature_layer
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: data only, no DDL, so no ACCESS EXCLUSIVE lock is held. Each
-- statement touches a bounded set of credit_accounts rows: accounts with an
-- active trial and accounts on tier='enterprise' (a few dozen in prod).

-- Enterprise is a feature layer, not a billing plan
-- (.agents/skills/billing/references/plans-and-access.md). Money: tier is
-- 'free' or 'credits'. Features: enterprise_entitled (Licensed, a license
-- contract) and demo_enterprise (Demo, self-serve). Trials are removed.
--
-- The previous API reads tier='enterprise' and the trial columns; every write
-- below leaves an account it can still serve: a demo or licensed account keeps
-- its Enterprise features under the new API, and under the old one it reads as
-- the plan it pays for until the new tasks take over.

-- 1. An active Enterprise trial becomes the Enterprise demo, so nobody loses
--    access when trials go away.
UPDATE kortix.credit_accounts
   SET demo_enterprise = true,
       updated_at = now()
 WHERE trial_status = 'active'
   AND trial_tier = 'enterprise'
   AND trial_ends_at > now()
   AND demo_enterprise IS DISTINCT FROM true;--> statement-breakpoint

-- 2. Every trial ends: the columns stay for history, nothing reads them.
UPDATE kortix.credit_accounts
   SET trial_status = 'expired',
       updated_at = now()
 WHERE trial_status = 'active';--> statement-breakpoint

-- 3. tier='enterprise' becomes Licensed on the plan the account pays for.
--    Its expiring credits (a contract pool, admin grants) move to the
--    non-expiring bucket first: as Free or Credits the account takes part in
--    period resets, and a reset replaces the expiring bucket. The balance is
--    unchanged. A live Stripe subscription means Credits; Stripe's next sync
--    sets the exact plan and amount.
UPDATE kortix.credit_accounts
   SET enterprise_entitled = true,
       -- The _precise columns are canonical; sync_credit_account_precision_columns
       -- rounds the legacy pair from them.
       non_expiring_credits_precise = coalesce(non_expiring_credits_precise, 0) + coalesce(expiring_credits_precise, 0),
       expiring_credits_precise = 0,
       tier = CASE
                WHEN stripe_subscription_id IS NOT NULL
                 AND stripe_subscription_status IN ('active', 'trialing', 'past_due')
                THEN 'credits'
                ELSE 'free'
              END,
       updated_at = now()
 WHERE tier = 'enterprise';
