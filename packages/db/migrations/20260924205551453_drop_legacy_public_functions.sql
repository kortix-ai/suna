-- Migration: drop_legacy_public_functions
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Drops 57 functions in `public` that the retired Suna backend created and no
-- Kortix code calls. Baseline databases (local, CI, self-host) never had them;
-- they exist only in databases that predate the Kortix baseline. Every drop is
-- `IF EXISTS` with the exact signature, so a re-run and a database without
-- them are both no-ops. No CASCADE: an unexpected dependent object makes the
-- migration fail instead of taking the dependent with it.
--
-- Kept on purpose, although they are also legacy:
--   * public.delete_user_data(uuid, uuid): the active pg_cron job
--     `process-scheduled-account-deletions` calls it through
--     public.process_scheduled_account_deletions().
--   * public.get_user_email(uuid): the trigger function
--     basejump.ensure_billing_customer_email() calls it.
--   * public.add_credits(uuid, numeric, uuid) and
--     public.grant_tier_credits(uuid, text, numeric): other overloads of two
--     dropped names; not part of this cleanup.
--
-- mixed-version-safe: drops only functions that no running code calls. A git grep of every name over apps/, packages/, infra/, supabase/ and scripts/ finds 0 callers. A read-only catalog check of dev, staging and prod on 2026-09-24 found no view, trigger, policy, column default, check constraint, pg_cron command or surviving function body that references a dropped function, and pg_stat_statements shows no call to any of them. Migration 20260924194804787 already revoked client-role EXECUTE on them. The guard below repeats the function-body and pg_cron checks at apply time.

DO $$
DECLARE
  drop_list constant text[] := ARRAY[
    -- Their tables or columns no longer exist; a call can only fail.
    'public.add_agent_to_library(uuid, uuid)',
    'public.add_credits(uuid, numeric, text, text, uuid)',
    'public.create_agent_kb_processing_job(uuid, uuid, character varying, jsonb)',
    'public.create_agent_version(uuid, text, jsonb, jsonb, jsonb, uuid)',
    'public.create_template_from_agent(uuid, uuid)',
    'public.deduct_credits(uuid, numeric, text, uuid, text)',
    'public.find_suna_default_agent_for_account(uuid)',
    'public.get_agent_config(uuid)',
    'public.get_agent_kb_processing_jobs(uuid, integer)',
    'public.get_agent_knowledge_base(uuid, boolean)',
    'public.get_all_suna_default_agents()',
    'public.get_credit_balance(uuid)',
    'public.get_missing_credentials_for_template(uuid, uuid)',
    'public.get_thread_knowledge_base(uuid, boolean)',
    'public.grant_tier_credits(uuid, numeric, character varying)',
    'public.install_template_as_instance(uuid, uuid, character varying)',
    'public.migrate_agents_to_versioned()',
    'public.migrate_user_to_credits(uuid)',
    'public.switch_agent_version(uuid, uuid, uuid)',
    'public.update_agent_kb_job_status(uuid, character varying, jsonb, integer, integer, text)',
    -- Retired Suna account, admin, scheduling and transcript helpers.
    'public.admin_list_users_by_tier(text, text, integer, integer, text, text)',
    'public.delete_user_immediately(uuid, uuid)',
    'public.execute_account_deletion(uuid)',
    'public.get_llm_formatted_messages(uuid)',
    'public.get_user_account_by_email(text)',
    'public.get_user_metadata(uuid)',
    'public.schedule_trigger_http(text, text, text, jsonb, jsonb, integer)',
    'public.unschedule_job_by_name(text)',
    -- Retired Suna analytics readers.
    'public.get_active_subscription_counts()',
    'public.get_active_users_week(timestamp with time zone)',
    'public.get_conversation_insights(timestamp with time zone, timestamp with time zone)',
    'public.get_daily_top_users(timestamp with time zone, timestamp with time zone, integer, integer, text)',
    'public.get_engagement_metrics(timestamp with time zone, timestamp with time zone, timestamp with time zone, timestamp with time zone)',
    'public.get_free_signups_funnel_counts(timestamp with time zone, timestamp with time zone)',
    'public.get_free_signups_with_activity(timestamp with time zone, timestamp with time zone)',
    'public.get_other_checkout_clicks_count(timestamp with time zone, timestamp with time zone)',
    'public.get_project_category_distribution(timestamp with time zone, timestamp with time zone)',
    'public.get_project_category_distribution(timestamp with time zone, timestamp with time zone, text)',
    'public.get_retention_cohorts(integer, integer)',
    'public.get_retention_data(integer, integer, integer, integer)',
    'public.get_revenuecat_revenue_by_tier(timestamp with time zone, timestamp with time zone)',
    'public.get_signup_activation_stats(timestamp with time zone, timestamp with time zone)',
    'public.get_signups_by_date(timestamp with time zone, timestamp with time zone)',
    'public.get_suna_default_agent_stats()',
    'public.get_task_performance(timestamp with time zone, timestamp with time zone)',
    'public.get_thread_message_distribution(timestamp with time zone, timestamp with time zone)',
    'public.get_thread_tier_distribution(timestamp with time zone, timestamp with time zone)',
    'public.get_threads_by_category(text, timestamp with time zone, timestamp with time zone, integer, integer, text, text, integer, integer)',
    'public.get_threads_by_category_count(text, timestamp with time zone, timestamp with time zone, integer, integer)',
    'public.get_threads_by_tier(text, timestamp with time zone, timestamp with time zone, integer, integer, text, text, integer, integer)',
    'public.get_threads_by_tier_and_category(text, text, timestamp with time zone, timestamp with time zone, integer, integer, text, text, integer, integer)',
    'public.get_threads_by_tier_and_category_count(text, text, timestamp with time zone, timestamp with time zone, integer, integer)',
    'public.get_threads_by_tier_count(text, timestamp with time zone, timestamp with time zone, integer, integer)',
    'public.get_usage_costs_by_tier(timestamp with time zone, timestamp with time zone)',
    'public.get_use_case_patterns(timestamp with time zone, timestamp with time zone, integer)',
    'public.get_vercel_analytics(date)',
    'public.get_vercel_analytics_range(date, date)'
  ];
  sig text;
  present oid[] := '{}';
  names text[];
  blocker text;
BEGIN
  FOREACH sig IN ARRAY drop_list LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      present := present || to_regprocedure(sig)::oid;
    END IF;
  END LOOP;

  IF cardinality(present) = 0 THEN
    RETURN;
  END IF;

  SELECT array_agg(DISTINCT proname) INTO names FROM pg_proc WHERE oid = ANY (present);

  -- A SQL or PL/pgSQL body that calls a function records no pg_depend row, so
  -- DROP FUNCTION would succeed and leave the caller broken. Refuse instead.
  SELECT string_agg(DISTINCT format('%s.%s calls %s', n.nspname, p.proname, t.name), '; ')
    INTO blocker
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language l ON l.oid = p.prolang
  CROSS JOIN unnest(names) AS t(name)
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND l.lanname IN ('sql', 'plpgsql')
    AND NOT (p.oid = ANY (present))
    AND p.prosrc ~ ('\m' || t.name || '\M');
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'legacy function drop refused, still referenced: %', blocker;
  END IF;

  -- A pg_cron command is plain text and records no dependency either.
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$
      SELECT string_agg(DISTINCT format('pg_cron job %s calls %s', j.jobname, t.name), '; ')
      FROM cron.job j
      CROSS JOIN unnest($1::text[]) AS t(name)
      WHERE j.command ~ ('\m' || t.name || '\M')
    $q$ INTO blocker USING names;
    IF blocker IS NOT NULL THEN
      RAISE EXCEPTION 'legacy function drop refused, still referenced: %', blocker;
    END IF;
  END IF;

  FOREACH sig IN ARRAY drop_list LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', sig);
  END LOOP;
END
$$;
