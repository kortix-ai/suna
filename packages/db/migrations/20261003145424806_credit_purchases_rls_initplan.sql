-- Cache statement-stable auth calls in the four legacy credit purchase policies.
-- ALTER POLICY preserves roles, commands, permissiveness and implicit checks.
-- This public table is absent from baseline databases; never create it or policies.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
DECLARE
  policy_name text;
BEGIN
  IF to_regclass('public.credit_purchases') IS NULL THEN
    RETURN;
  END IF;

  FOR policy_name IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname IN (
        'Service role can manage all credit purchases',
        'Service role manages credit purchases'
      )
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.credit_purchases USING ((select auth.role()) = %L::text)',
      policy_name, 'service_role');
  END LOOP;

  FOR policy_name IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname IN (
        'Users can view own credit purchases',
        'Users can view their own credit purchases'
      )
  LOOP
    EXECUTE format('ALTER POLICY %I ON public.credit_purchases USING ((select auth.uid()) = account_id)',
      policy_name);
  END LOOP;
END
$$;
