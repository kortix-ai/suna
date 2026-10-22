-- Migration: drop_legacy_account_user_select_policy
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- The Supabase performance advisor (lint auth_rls_initplan) flags the basejump
-- account framework's legacy SELECT policy "users can view their own
-- account_users": its USING clause calls auth.uid() for every row.
--
-- The policy guards nothing. Basejump was retired on 2026-07-06
-- (20260706120000000_retire_basejump): app code stopped reading and writing
-- basejump.* in that deploy, the API connects as postgres/service_role (which
-- RLS does not apply to), and web, mobile and the SDK never query the schema
-- through PostgREST. A fresh install's bootstrap stub (0000_bootstrap.sql)
-- creates basejump.account_user WITHOUT any policy — this policy exists only
-- on databases that predate the baseline. Dropping it clears the advisor
-- finding and moves those databases to the fresh-install state.
--
-- Scope: exactly this one policy. The table keeps its rows (prod holds ~394k
-- historical memberships) and its other two legacy policies ("users can view
-- their teammates", "Account users can be deleted by owners except primary
-- account owner" — not flagged by this lint, and separate advisor findings of
-- their own). The full basejump drop remains the separate planned migration.
--
-- mixed-version-safe: no code path reads through this policy — the basejump
-- readers left in the 2026-07-06 retirement deploy and nothing queried the
-- table as an RLS-restricted role since.
DO $$ BEGIN
  IF to_regclass('basejump.account_user') IS NOT NULL THEN
    DROP POLICY IF EXISTS "users can view their own account_users" ON basejump.account_user;
  END IF;
END $$;
