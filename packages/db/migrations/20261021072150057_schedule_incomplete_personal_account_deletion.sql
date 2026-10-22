-- Personal bootstrap writes the account before its membership. Admin deletion
-- must also schedule that incomplete scaffold. Keep the live-member guard and
-- the shared API sweep, including its financial/audit retention policy.
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
  -- Schedule every account this user was a member of, and whose only live
  -- member they were, for the API deletion routine. A pending request that
  -- exists already is made due now. The exception keeps the auth-user delete
  -- itself working; the warning leaves the failure visible in the logs.
  DECLARE
    orphan uuid;
  BEGIN
    FOR orphan IN
      SELECT a.account_id
        FROM kortix.accounts a
       WHERE (a.account_id = OLD.id OR EXISTS (
               SELECT 1 FROM kortix.account_memberships m
                WHERE m.account_id = a.account_id AND m.user_id = OLD.id
             ))
         AND NOT EXISTS (
               SELECT 1 FROM kortix.account_memberships m
                WHERE m.account_id = a.account_id
                  AND m.user_id <> OLD.id
                  AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = m.user_id)
             )
    LOOP
      UPDATE kortix.account_deletion_requests
         SET scheduled_for = least(scheduled_for, now())
       WHERE account_id = orphan AND status = 'pending';
      IF NOT FOUND THEN
        INSERT INTO kortix.account_deletion_requests (account_id, user_id, status, reason, scheduled_for)
        VALUES (orphan, OLD.id, 'pending', 'auth user deleted', now());
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[revoke-credentials] scheduling account deletion for deleted user % failed: %', OLD.id, SQLERRM;
  END;
  RETURN OLD;
END;
$$;
