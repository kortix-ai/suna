-- KRTX-1155: one permissive policy per command on the legacy public table.
-- Preserve the old ALL service predicate for writes and its OR with ownership
-- for SELECT. Keep the init-plan wrappers introduced by KRTX-1130.
-- Fresh installations only have kortix.account_deletion_requests: no-op there.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.account_deletion_requests') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Service role can manage deletion requests" ON public.account_deletion_requests;
    DROP POLICY IF EXISTS "Users can view their own deletion requests" ON public.account_deletion_requests;
    DROP POLICY IF EXISTS "Service role can insert deletion requests" ON public.account_deletion_requests;
    DROP POLICY IF EXISTS "Service role can update deletion requests" ON public.account_deletion_requests;
    DROP POLICY IF EXISTS "Service role can delete deletion requests" ON public.account_deletion_requests;

    CREATE POLICY "Users can view their own deletion requests" ON public.account_deletion_requests
      FOR SELECT USING (
        (select auth.role()) = 'service_role'::text OR (select auth.uid()) = user_id
      );
    CREATE POLICY "Service role can insert deletion requests" ON public.account_deletion_requests
      FOR INSERT WITH CHECK ((select auth.role()) = 'service_role'::text);
    CREATE POLICY "Service role can update deletion requests" ON public.account_deletion_requests
      FOR UPDATE USING ((select auth.role()) = 'service_role'::text);
    CREATE POLICY "Service role can delete deletion requests" ON public.account_deletion_requests
      FOR DELETE USING ((select auth.role()) = 'service_role'::text);
  END IF;
END
$$;
