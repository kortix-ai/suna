-- Migration: referrals_single_select_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint multiple_permissive_policies) flags
-- public.referrals: one permissive ALL policy ("Service role manages referrals")
-- plus two permissive SELECT policies ("Users can view own referrals as
-- referred", "Users can view own referrals as referrer"), all TO PUBLIC, so
-- every role ran three policies for every SELECT (KRTX-1165).
--
-- Merge them into one permissive policy per action without changing their
-- predicates or role scope, exactly like the legacy wallet got
-- (20261003145424807_credit_accounts_single_select_policy): the two user
-- SELECT quals fold into the service policy's SELECT path with OR, and the ALL
-- policy's write path splits into INSERT/UPDATE/DELETE policies carrying the
-- same service-role predicate. The referral program was removed from the API
-- (every /v1/referrals route and the web modal are gone), the table is not in
-- the packages/db baseline, and it holds no rows on prod — but its grants and
-- policies stay exactly as permissive as before.
--
-- mixed-version-safe: the same rows and writes remain authorized; no data changes.
DO $$
DECLARE
  service_policy record;
  referred_policy record;
  referrer_policy record;
BEGIN
  IF to_regclass('public.referrals') IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO service_policy FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referrals'
      AND policyname = 'Service role manages referrals';
  SELECT * INTO referred_policy FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referrals'
      AND policyname = 'Users can view own referrals as referred';
  SELECT * INTO referrer_policy FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'referrals'
      AND policyname = 'Users can view own referrals as referrer';
  -- Fresh baselines lack the table; a partially migrated table lacks a policy.
  -- Do not invent access when any original policy is absent.
  IF service_policy.policyname IS NULL OR referred_policy.policyname IS NULL
     OR referrer_policy.policyname IS NULL THEN
    RETURN;
  END IF;
  IF service_policy.cmd <> 'ALL' OR referred_policy.cmd <> 'SELECT' OR referrer_policy.cmd <> 'SELECT'
     OR service_policy.permissive <> 'PERMISSIVE' OR referred_policy.permissive <> 'PERMISSIVE' OR referrer_policy.permissive <> 'PERMISSIVE'
     OR service_policy.roles <> ARRAY['public']::name[] OR referred_policy.roles <> ARRAY['public']::name[] OR referrer_policy.roles <> ARRAY['public']::name[]
     OR service_policy.qual IS NULL OR referred_policy.qual IS NULL OR referrer_policy.qual IS NULL THEN
    RAISE EXCEPTION 'Unexpected legacy referrals policy shape';
  END IF;

  DROP POLICY "Service role manages referrals" ON public.referrals;
  DROP POLICY "Users can view own referrals as referred" ON public.referrals;
  DROP POLICY "Users can view own referrals as referrer" ON public.referrals;
  EXECUTE format('CREATE POLICY "Service role manages referrals" ON public.referrals FOR SELECT USING ((%s) OR (%s) OR (%s))',
    service_policy.qual, referred_policy.qual, referrer_policy.qual);
  EXECUTE format('CREATE POLICY referrals_service_insert ON public.referrals FOR INSERT WITH CHECK (%s)',
    coalesce(service_policy.with_check, service_policy.qual));
  EXECUTE format('CREATE POLICY referrals_service_update ON public.referrals FOR UPDATE USING (%s) WITH CHECK (%s)',
    service_policy.qual, coalesce(service_policy.with_check, service_policy.qual));
  EXECUTE format('CREATE POLICY referrals_service_delete ON public.referrals FOR DELETE USING (%s)',
    service_policy.qual);
END
$$;
