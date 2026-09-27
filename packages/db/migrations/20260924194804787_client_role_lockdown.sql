-- Migration: client_role_lockdown
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Client roles (PUBLIC, anon, authenticated) reach Postgres through Supabase
-- PostgREST with nothing more than the public anon key or a user's own JWT.
-- They must never execute a privileged function or write billing state.
--
-- Before this migration, every environment built from the baseline let any
-- signed-up user call SECURITY DEFINER functions in `public`/`basejump`
-- (credit mint/drain, user deletion, pg_cron HTTP jobs, email lookups) and the
-- SECURITY INVOKER wallet RPCs, because the baseline and
-- 20260704160000000_reassert_kortix_runtime_grants granted EXECUTE on ALL
-- functions in `public` to `authenticated`. The anon key could also read and
-- write several RLS-off legacy tables, and read every `kortix` table wherever
-- PostgREST exposes that schema.
--
-- Nothing legitimate depends on those grants: the API calls the credit RPCs
-- and reads `kortix` as postgres / service_role; web, mobile and the SDK make
-- no `.rpc()` calls and never query `kortix` through PostgREST. RLS policies
-- only call basejump.has_role_on_account / get_accounts_with_role, which stay
-- granted. Supabase-internal roles keep explicit EXECUTE so auth/storage hooks
-- that relied on the PUBLIC grant keep working.
--
-- Idempotent: dev, staging and prod received the same statements by hand on
-- 2026-09-24 during incident response.
-- mixed-version-safe: only revokes grants from client roles; no running code path uses them (API connects as postgres/service_role)

DO $$
DECLARE
  r record;
  client_roles text;
  internal_roles text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO client_roles
  FROM (SELECT 'PUBLIC' AS rolname
        UNION ALL
        SELECT quote_ident(rolname) FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) x;

  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname) INTO internal_roles
  FROM pg_roles
  WHERE rolname IN ('service_role', 'supabase_auth_admin', 'supabase_storage_admin',
                    'supabase_functions_admin', 'supabase_realtime_admin', 'dashboard_user');

  -- 1. Privileged functions: every SECURITY DEFINER function in the exposed
  --    schemas except the two RLS helpers, plus the invoker wallet RPCs.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind = 'f'
      AND (
        (n.nspname IN ('public', 'basejump') AND p.prosecdef
          AND p.proname NOT IN ('has_role_on_account', 'get_accounts_with_role'))
        OR (n.nspname = 'public' AND p.proname LIKE 'atomic\_%')
      )
  LOOP
    IF internal_roles IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %s', r.sig, internal_roles);
    END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM %s', r.sig, client_roles);
  END LOOP;

  -- 2. Client roles never touch the `kortix` schema. The API reads and writes
  --    it as postgres/service_role (granted by 20260704160000000).
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA kortix FROM %I', r.rolname);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA kortix FROM %I', r.rolname);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA kortix FROM %I', r.rolname);
    EXECUTE format('REVOKE USAGE ON SCHEMA kortix FROM %I', r.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA kortix REVOKE ALL ON TABLES FROM %I', r.rolname);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA kortix REVOKE ALL ON SEQUENCES FROM %I', r.rolname);
  END LOOP;

  -- 3. Legacy RLS-off tables that the anon key could read and write.
  IF to_regclass('public.documents') IS NOT NULL
     AND NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.documents')) THEN
    ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
  END IF;
  FOR r IN
    SELECT c.oid::regclass AS t, x.rolname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN (SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) x
    WHERE n.nspname = 'public'
      AND c.relname IN ('documents', 'daily_refresh_tracking', 'vercel_analytics_daily',
                        'agent_templates_backup', 'agent_workflows_backup',
                        'agents_backup_cleanup_20250729')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM %I', r.t, r.rolname);
  END LOOP;

  -- 4. New functions created by this role are never born client-executable.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %s', client_roles);
  IF to_regnamespace('basejump') IS NOT NULL THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA basejump REVOKE EXECUTE ON FUNCTIONS FROM %s', client_roles);
  END IF;
END
$$;

-- Post-condition: fail the migration rather than leave a client-executable
-- privileged function behind (for example one owned by another role).
DO $$
DECLARE
  leaked text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO leaked
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind = 'f'
    AND (
      (n.nspname IN ('public', 'basejump') AND p.prosecdef
        AND p.proname NOT IN ('has_role_on_account', 'get_accounts_with_role'))
      OR (n.nspname = 'public' AND p.proname LIKE 'atomic\_%')
    )
    AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF leaked IS NOT NULL THEN
    RAISE EXCEPTION 'client roles can still execute privileged functions: %', leaked;
  END IF;
END
$$;
