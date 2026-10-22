-- Collapse the legacy public credit purchases to one permissive policy per
-- role and action. The pre-baseline table carries two identical service ALL
-- policies and two identical user SELECT policies, all granted to PUBLIC, so
-- every action evaluated 2-4 policies (Supabase lint
-- multiple_permissive_policies). Drop the exact duplicates, then scope the
-- surviving pair to the roles their predicates already admit: service_role
-- writes, authenticated own-account reads. Predicates, commands and
-- permissiveness are preserved; grants are untouched.
-- Fresh installs have only kortix.credit_purchases; never create the table.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
DECLARE
  service_keep pg_policies%rowtype;
  service_dup pg_policies%rowtype;
  user_keep pg_policies%rowtype;
  user_dup pg_policies%rowtype;
BEGIN
  IF to_regclass('public.credit_purchases') IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO service_keep FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname = 'Service role can manage all credit purchases';
  SELECT * INTO service_dup FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname = 'Service role manages credit purchases';
  SELECT * INTO user_keep FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname = 'Users can view own credit purchases';
  SELECT * INTO user_dup FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'credit_purchases'
      AND policyname = 'Users can view their own credit purchases';

  -- Drop a duplicate only when its survivor holds the identical definition;
  -- never remove access on an unexpected shape. Absent objects (a fresh
  -- apply, or a pair already collapsed) are a no-op.
  IF service_dup.policyname IS NOT NULL
     AND (service_keep.policyname IS NULL
          OR service_keep.cmd <> service_dup.cmd
          OR service_keep.permissive <> service_dup.permissive
          OR service_keep.roles <> service_dup.roles
          OR service_keep.qual IS DISTINCT FROM service_dup.qual
          OR service_keep.with_check IS DISTINCT FROM service_dup.with_check) THEN
    RETURN;
  END IF;
  IF user_dup.policyname IS NOT NULL
     AND (user_keep.policyname IS NULL
          OR user_keep.cmd <> user_dup.cmd
          OR user_keep.permissive <> user_dup.permissive
          OR user_keep.roles <> user_dup.roles
          OR user_keep.qual IS DISTINCT FROM user_dup.qual
          OR user_keep.with_check IS DISTINCT FROM user_dup.with_check) THEN
    RETURN;
  END IF;

  IF service_dup.policyname IS NOT NULL THEN
    DROP POLICY "Service role manages credit purchases" ON public.credit_purchases;
  END IF;
  IF user_dup.policyname IS NOT NULL THEN
    DROP POLICY "Users can view their own credit purchases" ON public.credit_purchases;
  END IF;

  -- PUBLIC eligibility is what makes every role evaluate both policies; the
  -- predicates already admit only service_role writes and own-account reads.
  -- ALTER POLICY preserves the predicate, command and permissiveness.
  IF service_keep.policyname IS NOT NULL THEN
    ALTER POLICY "Service role can manage all credit purchases" ON public.credit_purchases TO service_role;
  END IF;
  IF user_keep.policyname IS NOT NULL THEN
    ALTER POLICY "Users can view own credit purchases" ON public.credit_purchases TO authenticated;
  END IF;
END
$$;
