-- Evaluate request identity once per statement, not once per legacy role row.
-- ALTER POLICY preserves command, roles, permissiveness and implicit WITH CHECK.
-- Fresh baseline databases have neither this legacy table nor its policies.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'user_roles' AND policyname = 'Service role can manage all roles') THEN
    ALTER POLICY "Service role can manage all roles" ON public.user_roles
      USING ((select auth.role()) = 'service_role'::text);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'user_roles' AND policyname = 'Users can view their own role') THEN
    ALTER POLICY "Users can view their own role" ON public.user_roles
      USING ((select auth.uid()) = user_id);
  END IF;
END
$$;
