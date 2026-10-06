-- Migration: account_deletion_trigger_marks_for_sweep
--
-- Problem: the auth-user-delete trigger (20261003182500000) ran a bare
-- `DELETE FROM kortix.accounts`. That statement aborts on the non-cascading
-- FK edges (`project_session_connector_bindings` RESTRICTs the connector
-- deletes), the EXCEPTION block swallowed the abort, and the orphan account
-- survived. The trigger also never cancelled the Stripe subscription, so a
-- reclaimed account kept billing.
--
-- Fix: the trigger no longer deletes. It schedules the orphan account for the
-- API's deletion routine (billing/services/account-deletion.ts), which owns the
-- ordered data sweep, the sandbox teardown and the Stripe cancel. The worker
-- picks the request up on its next tick.
--
-- Also adds `processing_started_at`: the worker claims a due request with
-- status 'processing' and this timestamp; a claim older than 1 hour is
-- reclaimable, so a worker that died mid-run does not strand the request.
--
-- mixed-version-safe: the new column is nullable and old code never reads it.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.account_deletion_requests
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

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
       WHERE EXISTS (
               SELECT 1 FROM kortix.account_memberships m
                WHERE m.account_id = a.account_id AND m.user_id = OLD.id
             )
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
