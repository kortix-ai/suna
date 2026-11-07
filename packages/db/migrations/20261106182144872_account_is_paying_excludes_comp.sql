-- Migration: account_is_paying_excludes_comp
--
-- Workspaces C6 (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C6, §3.6). A workspace split off a paying account gets the keeper's
-- plan comped: `tier` is paid, `comp_plan_until` is set, and no subscription
-- exists. That comp is a gift, not a payment. Before this file,
-- kortix.account_is_paying counted the comped tier as paying, so:
--   - a split of a comped account would be held for owner confirmation and its
--     split-offs would get a second comp (previewSplitOffBilling /
--     applySplitOffBilling read this function);
--   - a dormant comped account would stay visible as "it pays".
-- Now a paid tier counts only with no comp, or with a subscription the
-- account bought during the comp (a live Stripe subscription or a RevenueCat
-- subscription). Purchases and enterprise contracts count as before.
--
-- Locks: CREATE OR REPLACE FUNCTION on a function only; no table lock. A
-- caller that already planned the old body finishes with it.
--
-- mixed-version-safe: the signature and the return type do not change. The old
-- image calls the same function and reads a boolean; only the answer for a
-- comped account changes, and only the new image writes comp_plan_until.
--
-- ROLL BACK: no down migration (repo policy). A forward migration restores the
-- body of 20261106153100000_workspaces_table.sql.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.account_is_paying(p_account_id uuid) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
           SELECT 1 FROM kortix.credit_accounts ca
            WHERE ca.account_id = p_account_id
              AND ((coalesce(ca.tier, 'free') NOT IN ('free', 'none')
                    AND (ca.comp_plan_until IS NULL
                         OR (ca.stripe_subscription_id IS NOT NULL
                             AND coalesce(ca.stripe_subscription_status, '') NOT IN ('canceled', 'unpaid', 'incomplete_expired'))
                         OR ca.revenuecat_subscription_id IS NOT NULL))
                   OR ca.lifetime_purchased_precise > 0))
      OR EXISTS (
           SELECT 1 FROM kortix.credit_purchases cp
            WHERE cp.account_id = p_account_id AND cp.status = 'completed')
      OR EXISTS (
           SELECT 1 FROM kortix.enterprise_contracts ec
            WHERE ec.account_id = p_account_id AND ec.status = 'active')
$$;
