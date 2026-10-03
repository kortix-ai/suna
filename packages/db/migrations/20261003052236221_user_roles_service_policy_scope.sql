-- Migration: user_roles_service_policy_scope
-- The legacy table is absent from fresh databases. Preserve the existing
-- predicates and commands; only the service role needs the management policy.
-- mixed-version-safe: service_role retains all access; users retain own-row SELECT.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_roles'
      AND policyname = 'Service role can manage all roles'
  ) THEN
    ALTER POLICY "Service role can manage all roles"
      ON public.user_roles TO service_role;
  END IF;
END
$$;
