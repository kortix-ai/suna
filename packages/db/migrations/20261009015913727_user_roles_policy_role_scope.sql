-- Migration: user_roles_policy_role_scope
--
-- KRTX-1166. The Supabase performance advisor (lint multiple_permissive_policies)
-- flags public.user_roles: both of its permissive policies target PUBLIC, so for
-- every subject role both policies apply and each SELECT evaluates two policies
-- (supabase/splinter groups permissive policies by role and action and flags any
-- group with more than one).
--
-- Scope each policy to the JWT role its predicate already requires — the same
-- remediation 20261004173004004 applied to the sibling legacy table
-- public.audit_log and 20261003145424808 applied to public.credit_ledger:
--   - "Service role can manage all roles" (ALL, auth.role() = 'service_role') can
--     only ever match a service-role request, so it applies TO service_role.
--   - "Users can view their own role" (SELECT, auth.uid() = user_id) can only
--     ever match an authenticated request, so it applies TO authenticated.
--
-- Access semantics do not change:
--   - A service-role request satisfied the service predicate before and still
--     does. Every Supabase role that holds service_role also carries BYPASSRLS,
--     so RLS never filtered service-role access in the first place.
--   - Any other role failed the service predicate before (the policy matched no
--     rows); now the policy does not apply to it at all. Same outcome.
--   - The authenticated SELECT path keeps its predicate and its grants, including
--     the platform-admin subqueries that legacy public.threads and public.projects
--     policies run against this table: they read the admin's own row through this
--     policy as an authenticated request. anon keeps its SELECT grant but loses
--     only a policy it could never satisfy: auth.uid() is null for an anon
--     request, so it saw no rows before either. The one narrowed case is a
--     hypothetical custom NOBYPASSRLS role carrying a user JWT; no code path
--     connects that way (PostgREST serves requests as anon, authenticated and
--     service_role only, and every direct connection in this repo runs as a
--     BYPASSRLS role), which is the same call 20261004173004004 made for
--     audit_log.
--
-- ALTER POLICY rewrites only the role list: the predicates stay byte-identical,
-- so no policy expression is re-evaluated or re-wrapped here, and the change
-- composes with 20261004120001000 (user_roles_rls_initplan) in either order —
-- that migration rewrites only the USING clauses these policies carry on
-- long-lived environments.
--
-- public.user_roles is a pre-baseline legacy table: the managed surface models
-- platform roles in kortix.platform_user_roles, fresh databases never create the
-- public one, and no app code references it directly. Each ALTER is guarded on
-- the policy's existence, so the migration is a no-op on a fresh database and
-- never invents access on a database whose policy shape drifted.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_roles'
      AND policyname = 'Service role can manage all roles'
  ) THEN
    ALTER POLICY "Service role can manage all roles" ON public.user_roles TO service_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_roles'
      AND policyname = 'Users can view their own role'
  ) THEN
    ALTER POLICY "Users can view their own role" ON public.user_roles TO authenticated;
  END IF;
END;
$$;
