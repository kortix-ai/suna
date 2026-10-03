-- The pre-baseline public ledger has both policies assigned to PUBLIC.
-- Scope them to their intended JWT roles so SELECT evaluates one policy.
-- Keep predicates and service-role writes unchanged. Fresh installs have
-- only kortix.credit_ledger; do not create or alter that table here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_ledger'
      AND policyname = 'Service role manages ledger'
  ) THEN
    ALTER POLICY "Service role manages ledger" ON public.credit_ledger TO service_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_ledger'
      AND policyname = 'Users can view own ledger'
  ) THEN
    ALTER POLICY "Users can view own ledger" ON public.credit_ledger TO authenticated;
  END IF;
END;
$$;
