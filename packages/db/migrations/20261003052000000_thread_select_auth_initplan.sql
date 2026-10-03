-- Cache the statement-constant JWT identity in the legacy threads read policy.
-- Access conditions, policy roles and the other thread policies stay unchanged.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'threads'
      AND policyname = 'thread_select_policy'
  ) THEN
    ALTER POLICY thread_select_policy ON public.threads USING (
      (is_public IS TRUE)
      OR (basejump.has_role_on_account(account_id) = true)
      OR (EXISTS (
        SELECT 1 FROM public.projects
        WHERE projects.project_id = threads.project_id
          AND ((projects.is_public IS TRUE)
            OR (basejump.has_role_on_account(projects.account_id) = true))
      ))
      OR (EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = (SELECT auth.uid())
          AND user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      ))
    );
  END IF;
END
$$;
