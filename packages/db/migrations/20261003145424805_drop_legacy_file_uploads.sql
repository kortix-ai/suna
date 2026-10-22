-- Migration: drop_legacy_file_uploads
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint auth_rls_initplan, WARN, EXTERNAL)
-- flags all four RLS policies of public.file_uploads: each one evaluates
-- auth.uid() and basejump.has_role_on_account() once per row. This migration
-- removes the cause instead of rewriting the policies: the whole table is a
-- leftover of the retired Suna backend that the Kortix baseline never
-- created.
--
-- Evidence the table is dead (prod catalog, read-only, 2026-10-02):
--   * zero rows: exact count(*) = 0, and pg_stat_user_tables records zero
--     inserts/updates/deletes since the cluster's stats epoch
--     (pg_stat_database.stats_reset is null -- the counters were never reset);
--   * zero index scans on every one of its 9 indexes (pkey, one unique, seven
--     secondary -- the advisor's unused_index findings name the seven
--     secondary ones);
--   * pg_stat_statements holds no statement naming the table besides this
--     investigation's own read-only count queries. (The ~50k seq_scan
--     count on the table predates the pg_stat_statements window; no current
--     statement names it.)
--   * no Kortix code reads or writes it: a repo-wide search finds the name
--     only in apps/api/src/scripts/legacy-transfer/cli.ts, the read-only
--     export tool for a separate legacy source project, whose inspect
--     command reports an absent table as `exposed: false` and continues.
--
-- One surviving database object still names the table:
-- public.delete_user_data(uuid, uuid), the account-deletion cascade that the
-- active pg_cron job process-scheduled-account-deletions calls daily (kept
-- on purpose by 20260924205551453_drop_legacy_public_functions). One of its
-- exception-wrapped blocks DELETEs FROM file_uploads -- dead work against a
-- table with no rows. This migration rewrites that function WITHOUT the
-- block (the body below is the prod definition observed 2026-10-02 with only
-- that block removed, whitespace normalized), then drops the table. Both run in
-- THIS single transaction, so the daily job sees either the pre-migration
-- state (function with the block, table present) or the post-migration state
-- (function without it, table gone) -- never a mix. A fresh install never
-- had the table nor the function, so both steps are no-ops there. Dropping
-- the table also clears the seven unused_index findings the advisor reports
-- on the same entity.
--
-- mixed-version-safe: no app can still be reading this table. The Suna
-- backend that owned it was replaced by the Kortix schema baseline
-- (0000_bootstrap.sql, curated from the retired backend; the drizzle
-- rebaseline landed 20260716021754_rebaseline_kortix_schema_20260716); no
-- app, job or query references the table any more -- the pg_stat_statements
-- check above is the surviving-caller proof -- and the one function that
-- still named it is rewritten in this same transaction. The guard below
-- repeats the function-body and pg_cron checks at apply time, refuses on any
-- row (an environment this investigation could not observe may have kept
-- data; the rows are unreachable by Kortix code, so exporting them first is
-- the operator's decision), and the DROP is RESTRICT so an unexpected
-- dependent object fails the migration instead of being taken with it.
DO $$
DECLARE
  legacy_delete_user_data oid := to_regprocedure('public.delete_user_data(uuid, uuid)');
  blocker text;
  row_count bigint;
BEGIN
  -- Rewire the live account-deletion cascade first: drop its dead
  -- file_uploads block so the body no longer names the table this migration
  -- removes. Guarded twice: only when the function exists at all, and only
  -- while its body still names the table (a database where the function is
  -- absent or already clean is left untouched).
  IF legacy_delete_user_data IS NOT NULL
    AND (SELECT prosrc FROM pg_proc WHERE oid = legacy_delete_user_data) ~* '\mfile_uploads\M' THEN
    CREATE OR REPLACE FUNCTION public.delete_user_data(p_account_id uuid, p_user_id uuid)
     RETURNS boolean
     LANGUAGE plpgsql
     SECURITY DEFINER
    AS $function$
DECLARE
    v_row_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Starting deletion for account_id: %, user_id: %', p_account_id, p_user_id;

    -- Delete storage files from file-uploads bucket
    BEGIN
        DELETE FROM storage.objects
        WHERE bucket_id = 'file-uploads'
          AND name LIKE p_account_id::text || '/%';
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % storage files from file-uploads bucket', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting storage files: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agent_runs WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_runs', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_runs: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM messages WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % messages', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting messages: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM threads WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % threads', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting threads: %', SQLERRM;
    END;

    BEGIN
        UPDATE agents
        SET current_version_id = NULL
        WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Nullified current_version_id for % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error nullifying agent versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agent_versions WHERE agent_id IN (
            SELECT agent_id FROM agents WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_versions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agents WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agents: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM projects WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % projects', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting projects: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM agent_templates WHERE creator_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_templates', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_templates: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM api_keys WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % api_keys', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting api_keys: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM credit_accounts WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % credit_accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting credit_accounts: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_subscriptions WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_subscriptions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_subscriptions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_customers WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_customers', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_customers: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.account_user WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_user', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_user: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM account_deletion_requests WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_deletion_requests', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_deletion_requests: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.accounts WHERE id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting accounts: %', SQLERRM;
    END;

    RAISE NOTICE 'Completed deletion for account_id: %', p_account_id;
    RETURN TRUE;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Critical error in delete_user_data: %', SQLERRM;
        RETURN FALSE;
END;
$function$;
  END IF;

  IF to_regclass('public.file_uploads') IS NULL THEN
    RETURN; -- fresh install: the baseline never created the table
  END IF;

  -- A SQL or PL/pgSQL body that reads the table records no pg_depend row, so
  -- DROP TABLE would succeed and leave the caller broken. Refuse instead
  -- (house pattern of 20260924205551453_drop_legacy_public_functions). The
  -- one known legacy reference (delete_user_data, above) was just rewritten;
  -- anything else still naming the table stops the migration here.
  SELECT string_agg(format('%s.%s references public.file_uploads', n.nspname, p.proname), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND p.prosrc ~* '\mfile_uploads\M';
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'legacy file_uploads drop refused, still referenced: %', blocker;
  END IF;

  -- A pg_cron command is plain text and records no dependency either.
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $cron$
      SELECT string_agg(format('pg_cron job %s references public.file_uploads', jobname), '; ')
      FROM cron.job WHERE command ~* '\mfile_uploads\M'
    $cron$ INTO blocker;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'legacy file_uploads drop refused, still referenced: %', blocker;
    END IF;
  END IF;

  -- Refuse on data: prod is proven empty above; an environment where this
  -- fails must export its rows first.
  EXECUTE 'SELECT count(*) FROM public.file_uploads' INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'legacy file_uploads drop refused, table holds % row(s): export them first, then drop by hand', row_count;
  END IF;

  DROP TABLE public.file_uploads RESTRICT;
END
$$;
