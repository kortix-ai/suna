-- Migration: user_memories_rls_auth_initplan
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint auth_rls_initplan, WARN, EXTERNAL)
-- flags the legacy table public.user_memories: its four authenticated policies
-- ("Users can view/insert/update/delete their own memories") evaluate
-- auth.uid() bare inside the shared basejump membership predicate, so
-- Postgres may re-evaluate it for every row instead of planning it once per
-- statement (an InitPlan). This rewrites the four policies with the advisor's
-- own remediation: wrap each call in (select auth.uid()).
--
-- The expressions stay semantically identical — same predicate, same rows,
-- same policy names, roles and commands (SELECT/USING, INSERT/WITH CHECK,
-- UPDATE/USING, DELETE/USING) — only the evaluation shape changes. The
-- "Service role has full access to memories" policy is untouched: it is
-- constant `true` and not flagged.
--
-- public.user_memories is legacy: it predates the monorepo baseline and is
-- created by neither the baseline nor 0000_bootstrap (drizzle excludes it —
-- "managed externally"). It exists only on long-lived databases. The guards
-- below make this migration a no-op on fresh installs and CI databases, and
-- never invent a policy that was not already there.
DO $user_memories_rls_auth_initplan$
BEGIN
  IF to_regclass('public.user_memories') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_memories'
      AND policyname = 'Users can view their own memories'
  ) THEN
    DROP POLICY "Users can view their own memories" ON public.user_memories;
    CREATE POLICY "Users can view their own memories" ON public.user_memories
      FOR SELECT TO authenticated
      USING (account_id IN (
        SELECT accounts.id
        FROM basejump.accounts
        WHERE accounts.primary_owner_user_id = (select auth.uid())
           OR accounts.id IN (
             SELECT account_user.account_id
             FROM basejump.account_user
             WHERE account_user.user_id = (select auth.uid())
           )
      ));
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_memories'
      AND policyname = 'Users can insert their own memories'
  ) THEN
    DROP POLICY "Users can insert their own memories" ON public.user_memories;
    CREATE POLICY "Users can insert their own memories" ON public.user_memories
      FOR INSERT TO authenticated
      WITH CHECK (account_id IN (
        SELECT accounts.id
        FROM basejump.accounts
        WHERE accounts.primary_owner_user_id = (select auth.uid())
           OR accounts.id IN (
             SELECT account_user.account_id
             FROM basejump.account_user
             WHERE account_user.user_id = (select auth.uid())
           )
      ));
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_memories'
      AND policyname = 'Users can update their own memories'
  ) THEN
    DROP POLICY "Users can update their own memories" ON public.user_memories;
    CREATE POLICY "Users can update their own memories" ON public.user_memories
      FOR UPDATE TO authenticated
      USING (account_id IN (
        SELECT accounts.id
        FROM basejump.accounts
        WHERE accounts.primary_owner_user_id = (select auth.uid())
           OR accounts.id IN (
             SELECT account_user.account_id
             FROM basejump.account_user
             WHERE account_user.user_id = (select auth.uid())
           )
      ));
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'user_memories'
      AND policyname = 'Users can delete their own memories'
  ) THEN
    DROP POLICY "Users can delete their own memories" ON public.user_memories;
    CREATE POLICY "Users can delete their own memories" ON public.user_memories
      FOR DELETE TO authenticated
      USING (account_id IN (
        SELECT accounts.id
        FROM basejump.accounts
        WHERE accounts.primary_owner_user_id = (select auth.uid())
           OR accounts.id IN (
             SELECT account_user.account_id
             FROM basejump.account_user
             WHERE account_user.user_id = (select auth.uid())
           )
      ));
  END IF;
END
$user_memories_rls_auth_initplan$;
