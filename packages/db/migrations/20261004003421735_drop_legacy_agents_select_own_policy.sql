-- Migration: drop_legacy_agents_select_own_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint multiple_permissive_policies) flags
-- public.agents: two permissive SELECT policies, agents_select_marketplace
-- and agents_select_own, apply to every role (no TO clause — roles = {public}).
--
-- agents_select_own is a leftover of the retired Suna agent marketplace
-- (pre-baseline backend/supabase/migrations 20250524062639_agents_table.sql
-- and 20250529125628_agent_marketplace.sql). Its USING clause,
-- basejump.has_role_on_account(account_id), is the second disjunct of
-- agents_select_marketplace's USING clause, is_public = true OR
-- basejump.has_role_on_account(account_id). Permissive policies are ORed, so
-- for every role the pair admits exactly the rows the marketplace policy
-- admits alone: dropping agents_select_own changes no visible row set.
--
-- Scope: exactly this one policy. The table keeps its ~381k legacy rows and
-- its other four policies (agents_insert_own, agents_update_own,
-- agents_delete_own, agents_select_marketplace — not flagged by this lint).
-- No Kortix code reads public.agents as an RLS-restricted role: the table is
-- not in the managed baseline (schema kortix plus billing objects in public),
-- and web, mobile and the SDK never query it. The legacy prod functions that
-- touch the table — delete_user_data, publish_agent_to_marketplace,
-- unpublish_agent_from_marketplace, get_marketplace_agents,
-- get_agent_mcp_config, count_suna_agents_by_version,
-- find_suna_agents_needing_update — are all SECURITY DEFINER owned by
-- postgres, the table owner, which RLS does not apply to
-- (relforcerowsecurity = false on the table). Baseline databases (fresh
-- installs) never had the table; this migration is a no-op there.
--
-- mixed-version-safe: the dropped policy guards no row that
-- agents_select_marketplace does not already guard (A implies A OR B), and
-- no code path queries public.agents as an RLS-restricted role — the repo
-- (apps/, packages/, infra/, supabase/, scripts/) has no runtime reference
-- to the table outside the legacy delete_user_data body (kept for the
-- process-scheduled-account-deletions pg_cron job by
-- 20260924205551453_drop_legacy_public_functions), and every prod function
-- touching the table runs SECURITY DEFINER as the table owner (above).
DO $$ BEGIN
  IF to_regclass('public.agents') IS NOT NULL THEN
    DROP POLICY IF EXISTS agents_select_own ON public.agents;
  END IF;
END $$;
