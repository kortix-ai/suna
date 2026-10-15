-- Migration: billing_admins_trials_from_demo
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- One plan system (.agents/skills/billing/references/plans-and-access.md).
-- Data only: no column is dropped here. The API that ships with this
-- migration no longer reads demo_enterprise, enterprise_entitled or
-- managed_models_override; the previous API still does, and every write below
-- leaves those columns as they are, so a task of either version reads a
-- consistent account during the rollout.

-- 1. Admins manage billing. `billing.write` (plan checkout, top-ups, auto
--    top-up, the Stripe portal, accepting an Enterprise offer) moves from
--    owner-only to the built-in admin role. It stays non-delegable: a custom
--    role still cannot hold it.
INSERT INTO kortix.role_permissions (role_id, action)
SELECT r.role_id, 'billing.write'
  FROM kortix.roles r
 WHERE r.account_id IS NULL AND r.key = 'admin' AND r.scope_type = 'account'
ON CONFLICT DO NOTHING;--> statement-breakpoint

UPDATE kortix.roles
   SET description = 'Manage members, groups, roles, tokens and billing.', updated_at = now()
 WHERE account_id IS NULL AND key = 'admin' AND scope_type = 'account';--> statement-breakpoint

-- 2. The Enterprise preview becomes a 14-day Enterprise trial. An account with
--    the preview on (column, or an unexpired JSONB entry) that is not already
--    on Enterprise and has no active trial gets a dated trial instead, so it
--    sees an end date and gets warned before access ends.
UPDATE kortix.credit_accounts
   SET trial_status = 'active',
       trial_tier = 'enterprise',
       trial_started_at = now(),
       trial_ends_at = now() + interval '14 days',
       trial_note = 'Enterprise preview, converted to a 14-day Enterprise trial',
       updated_at = now()
 WHERE coalesce(tier, '') <> 'enterprise'
   AND coalesce(trial_status, 'none') <> 'active'
   AND (
     demo_enterprise = true
     OR (
       entitlement_overrides -> 'demoEnterprise' ->> 'value' = 'true'
       AND (
         entitlement_overrides -> 'demoEnterprise' ->> 'expires_at' IS NULL
         OR (entitlement_overrides -> 'demoEnterprise' ->> 'expires_at')::timestamptz > now()
       )
     )
   );--> statement-breakpoint

-- 3. The managed-models column override moves to its JSONB key, which is the
--    one override store. An existing JSONB entry wins.
UPDATE kortix.credit_accounts
   SET entitlement_overrides = coalesce(entitlement_overrides, '{}'::jsonb)
         || jsonb_build_object('managedModels', jsonb_build_object('value', managed_models_override)),
       updated_at = now()
 WHERE managed_models_override IS NOT NULL
   AND NOT (coalesce(entitlement_overrides, '{}'::jsonb) ? 'managedModels');--> statement-breakpoint

-- 4. Every account on the Enterprise plan without a contract on file gets an
--    open-ended manual contract record, so the admin console shows what it is
--    on and the plan has one source of truth. Amounts are 0: an operator
--    fills in the real terms.
INSERT INTO kortix.enterprise_contracts (account_id, status, license_usd, credits_usd, term_months, collection, starts_at, note)
SELECT ca.account_id, 'active', 0, 0, 12, 'manual', now(), 'Recorded when contracts were introduced; fill in the terms'
  FROM kortix.credit_accounts ca
 WHERE ca.tier = 'enterprise'
   AND NOT EXISTS (
     SELECT 1 FROM kortix.enterprise_contracts c
      WHERE c.account_id = ca.account_id AND c.status = 'active'
   );
