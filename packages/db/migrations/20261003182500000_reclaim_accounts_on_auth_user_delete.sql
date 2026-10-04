-- Migration: reclaim_accounts_on_auth_user_delete
--
-- 20260929225114414 taught this trigger to revoke the credentials of a deleted
-- auth user (Supabase Auth admin API: DELETE FROM auth.users). It left the
-- user's Kortix accounts behind: `kortix.accounts` has no FK to auth.users, so
-- the personal account (account_id = user_id) survived its owner. Its projects
-- kept existing with no member left to reach them — GET returned 403 "You do
-- not have access to this account", a re-signup with the same address booted a
-- fresh account, and the resources were unreclaimable (KRTX-1300, the
-- pub-empty-states journey).
--
-- This migration extends the same trigger (same event, same transaction): an
-- account whose every LIVE member is the deleted user is deleted with them.
-- The delete cascades through the schema's ON DELETE CASCADE foreign keys
-- (projects, memberships, invitations, tokens, git connections, ...), so the
-- projects go with the account instead of rotting unreachable.
--
-- The rule is membership-driven, not role-driven: whatever roles said, an
-- account whose last live member is gone can never be reached again — that is
-- the orphan. A member whose auth user still exists keeps the account alive,
-- so a shared workspace is never destroyed under the survivors. Members whose
-- auth users are already gone (deleted before this rule existed) do not keep
-- an account alive: the check counts LIVE members, so the account is
-- reclaimed by whichever of its remaining deletes comes last.
--
-- Provider-side resources the DB cannot reach: a reclaimed account's sandbox
-- rows cascade away too, and the orphan-box reaper
-- (apps/api/src/projects/reaping/orphan-boxes.ts) stops provider boxes that
-- lose their DB reference — the designed safety net for exactly this class.
-- The product's own account-deletion flow (apps/api/src/billing/services/
-- account-deletion.ts) reclaims sandboxes BEFORE it deletes the auth user;
-- a deletion made outside that flow (the Supabase admin path this issue
-- describes) relies on the reaper.
--
-- No backfill: accounts orphaned BEFORE this migration keep their rows. A
-- historical sweep deletes real user data at migration time and stays out of
-- a single-transaction migration (2026-08-10 v0.12.7 outage rule); it would
-- need its own reviewed, batched pass.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.revoke_credentials_of_deleted_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kortix
AS $$
BEGIN
  UPDATE kortix.account_tokens
     SET status = 'revoked', revoked_at = coalesce(revoked_at, now())
   WHERE user_id = OLD.id AND (status <> 'revoked' OR revoked_at IS NULL);
  UPDATE kortix.oauth_access_tokens
     SET revoked_at = coalesce(revoked_at, now())
   WHERE user_id = OLD.id AND revoked_at IS NULL;
  UPDATE kortix.oauth_refresh_tokens
     SET revoked_at = coalesce(revoked_at, now())
   WHERE user_id = OLD.id AND revoked_at IS NULL;
  UPDATE kortix.yolo_member_tokens
     SET revoked_at = coalesce(revoked_at, now())
   WHERE user_id = OLD.id AND revoked_at IS NULL;
  DELETE FROM kortix.oauth_authorization_codes
   WHERE user_id = OLD.id AND used_at IS NULL;
  -- Reclaim every account this user was a member of whose only live member
  -- they were. The exception keeps the auth-user delete itself working when
  -- an environment's cascade topology drifts (a referencing table without
  -- ON DELETE CASCADE would abort the whole delete); the warning leaves the
  -- failure visible in the logs instead of silently keeping the orphan.
  BEGIN
    DELETE FROM kortix.accounts a
     WHERE EXISTS (
             SELECT 1
               FROM kortix.account_memberships m
              WHERE m.account_id = a.account_id
                AND m.user_id = OLD.id
           )
       AND NOT EXISTS (
             SELECT 1
               FROM kortix.account_memberships m
              WHERE m.account_id = a.account_id
                AND m.user_id <> OLD.id
                AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
           );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[revoke-credentials] account reclamation for deleted user % failed: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;
