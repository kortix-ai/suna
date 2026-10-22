-- The pre-baseline public credit_usage table has both policies assigned to
-- PUBLIC, so the advisor's multiple_permissive_policies lint counts two
-- policies in every role's SELECT group. Scope each to the only role its
-- predicate can pass; predicates and service-role writes stay unchanged.
-- Consolidation is wrong here: one policy for both predicates would be FOR ALL
-- (granting users writes) or FOR SELECT (dropping service-role writes).
-- Fresh installs have only kortix.credit_usage; do not create or alter that
-- table here.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_usage'
      AND policyname = 'Service role can manage all credit usage'
  ) THEN
    ALTER POLICY "Service role can manage all credit usage" ON public.credit_usage TO service_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_usage'
      AND policyname = 'Users can view their own credit usage'
  ) THEN
    ALTER POLICY "Users can view their own credit usage" ON public.credit_usage TO authenticated;
  END IF;
END;
$$;
