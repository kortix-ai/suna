-- Merge the legacy wallet's overlapping public SELECT policies without changing
-- their predicates or role scope. Split the service ALL policy into write paths.
-- mixed-version-safe: the same rows and writes remain authorized; no data changes.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
DECLARE
  service_policy record;
  user_policy record;
BEGIN
  IF to_regclass('public.credit_accounts') IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO service_policy FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_accounts'
      AND policyname = 'Service role manages credit accounts';
  SELECT * INTO user_policy FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_accounts'
      AND policyname = 'Users can view own credit account';
  -- Fresh baselines lack the table; a second apply lacks the user policy.
  -- Do not invent access when either original policy is absent.
  IF service_policy.policyname IS NULL OR user_policy.policyname IS NULL THEN
    RETURN;
  END IF;
  IF service_policy.cmd <> 'ALL' OR user_policy.cmd <> 'SELECT'
     OR service_policy.permissive <> 'PERMISSIVE' OR user_policy.permissive <> 'PERMISSIVE'
     OR service_policy.roles <> ARRAY['public']::name[] OR user_policy.roles <> ARRAY['public']::name[]
     OR service_policy.qual IS NULL OR user_policy.qual IS NULL THEN
    RAISE EXCEPTION 'Unexpected legacy credit_accounts policy shape';
  END IF;

  DROP POLICY "Service role manages credit accounts" ON public.credit_accounts;
  DROP POLICY "Users can view own credit account" ON public.credit_accounts;
  EXECUTE format('CREATE POLICY "Service role manages credit accounts" ON public.credit_accounts FOR SELECT USING ((%s) OR (%s))',
    service_policy.qual, user_policy.qual);
  EXECUTE format('CREATE POLICY credit_accounts_service_insert ON public.credit_accounts FOR INSERT WITH CHECK (%s)',
    coalesce(service_policy.with_check, service_policy.qual));
  EXECUTE format('CREATE POLICY credit_accounts_service_update ON public.credit_accounts FOR UPDATE USING (%s) WITH CHECK (%s)',
    service_policy.qual, coalesce(service_policy.with_check, service_policy.qual));
  EXECUTE format('CREATE POLICY credit_accounts_service_delete ON public.credit_accounts FOR DELETE USING (%s)',
    service_policy.qual);
END
$$;
