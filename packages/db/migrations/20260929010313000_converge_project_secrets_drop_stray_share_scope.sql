-- Migration: converge_project_secrets_drop_stray_share_scope
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';
--
-- DB Drift Sentinel's dev job found kortix.project_secrets.share_scope
-- (USER-DEFINED secret_share_scope, default 'project', NOT NULL) live on
-- dev but absent from the committed migrations.
--
-- This column is not new debris -- it is a RE-ADDITION. It existed
-- (project_secrets.share_scope + project_secret_grants, the per-secret
-- member/group sharing model from PR #4039) and was deliberately dropped by
-- 20260706130001000_secrets_v2_identifier_model.sql ("Secrets v2 --
-- authorization centralization ... a secret is now always project-wide").
-- kortix.ts's doc comment on secretShareScopeEnum (packages/db/src/schema/
-- kortix.ts) says explicitly: "project_secrets itself no longer uses
-- either (secret sharing was retired ...)". No route, service or test under
-- apps/api/src on origin/main reads or writes project_secrets.share_scope
-- (grep clean); there is no open or merged PR since #4039 that re-adds it.
--
-- dev's own migration ledger shows 20260706130001000 applied on
-- 2026-07-06T14:15:32Z, and every one of its OTHER effects held: `identifier`
-- exists, `agent_scope` is gone, `project_secret_grants` is gone. Only
-- `share_scope` came back -- and every one of its 481 rows on dev holds the
-- column DEFAULT ('project'), zero rows differ, which is the signature of a
-- column re-added by a bare `ADD COLUMN ... DEFAULT` backfilling the whole
-- table, not of real per-secret sharing choices being made through the app.
-- staging and prod do not have this column (read-only check, both false).
-- Conclusion: dev drifted by hand (or an unmerged/abandoned branch run
-- directly against dev) after the 2026-07-06 retirement. The migrations are
-- right; dev is wrong. Converge dev back to the committed design.
--
-- mixed-version-safe: no deployed or in-flight API version reads or writes
-- project_secrets.share_scope -- it has been fully retired since 2026-07-06
-- (secrets authorization is the agent-side `secrets` grant only, resolved by
-- `identifier`). IF EXISTS makes this a no-op on staging and prod, which
-- never had the stray column.

DO $$
BEGIN
  ALTER TABLE kortix.project_secrets DROP COLUMN IF EXISTS share_scope;
END
$$;
