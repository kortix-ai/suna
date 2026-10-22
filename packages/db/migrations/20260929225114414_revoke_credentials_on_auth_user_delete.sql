-- Migration: revoke_credentials_on_auth_user_delete
--
-- Deleting an auth user (Supabase Auth admin API: DELETE FROM auth.users) left
-- that person's Kortix credentials valid: the user_id columns of the token
-- tables have no FK to auth.users, and validation reads only the token row.
-- This trigger revokes, at the source and in the same transaction as the
-- delete, every credential that acts AS the user.
--
-- Revoked (act as the user): account_tokens (PATs, project tokens, session
--   tokens: user_id is the acting identity), oauth_access_tokens,
--   oauth_refresh_tokens, yolo_member_tokens. Unused oauth authorization codes
--   are deleted (a code is redeemable into a token pair).
-- Non-auth principals: a service account (also an agent principal) has no
--   auth.users row. Its tokens carry user_id = service_account_id. The trigger
--   never sees that id (only real auth deletes fire it) and the backfill below
--   excludes it. Every other writer of these user_id columns stores an auth
--   user id (PAT/project/CLI mint, session launcher, OAuth grant, app viewer,
--   YOLO seat).
-- Kept (belong to the account/project, not the person; created_by is
--   provenance only): scim_tokens, gateway_api_keys, service accounts.
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
  RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION kortix.revoke_credentials_of_deleted_user() FROM PUBLIC;

-- auth.users is Supabase-managed; a role without TRIGGER on it must attach the
-- trigger by hand (same tolerance as 20260706120000000_retire_basejump).
DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS revoke_credentials_on_user_delete ON auth.users;
    CREATE TRIGGER revoke_credentials_on_user_delete
      AFTER DELETE ON auth.users
      FOR EACH ROW EXECUTE FUNCTION kortix.revoke_credentials_of_deleted_user();
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING '[revoke-credentials] NO PRIVILEGE to create the auth.users trigger: deleted users keep working credentials until it is created by a superuser. Verify: select tgname from pg_trigger where tgrelid = ''auth.users''::regclass and tgname = ''revoke_credentials_on_user_delete''';
END $$;

-- One-time idempotent backfill: credentials of users deleted before the
-- trigger existed. Touches only ACTIVE rows whose user is already gone and
-- whose user_id is not a service account.
-- backfill-safe: token tables hold at most tens of thousands of rows; only active rows of already-deleted users are written (expected a handful); no writer queues behind row locks on revoked-to-be credentials.
DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    UPDATE kortix.account_tokens t SET status = 'revoked', revoked_at = coalesce(revoked_at, now())
     WHERE t.status = 'active' AND t.revoked_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.service_accounts s WHERE s.service_account_id = t.user_id);
    UPDATE kortix.oauth_access_tokens t SET revoked_at = now()
     WHERE t.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.service_accounts s WHERE s.service_account_id = t.user_id);
    UPDATE kortix.oauth_refresh_tokens t SET revoked_at = now()
     WHERE t.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.service_accounts s WHERE s.service_account_id = t.user_id);
    UPDATE kortix.yolo_member_tokens t SET revoked_at = now()
     WHERE t.revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id)
       AND NOT EXISTS (SELECT 1 FROM kortix.service_accounts s WHERE s.service_account_id = t.user_id);
  END IF;
END $$;
