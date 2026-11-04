-- Migration: self_host_signup_hook
--
-- The auth service's before-user-created hook for a self-hosted instance. The
-- Kortix self-host Compose file points GOTRUE_HOOK_BEFORE_USER_CREATED_URI at
-- this function; Kortix cloud does not, so it stays inert there. GoTrue calls it
-- before it creates a user from an email/phone sign-up, a magic link, an OAuth
-- or SAML sign-in, or an invite. It does not call it for a user the service key
-- creates through the admin API (`kortix self-host admin add`).
--
-- Decision, read from kortix.self_host_signup_policy (no row: allow):
--   1. An SSO (SAML) identity is always allowed. An SSO user never matches the
--      platform-admin allowlist (KRTX-1715), and DISABLE_SIGNUP stays the only
--      switch that stops first SSO sign-ins.
--   2. An address in reserved_emails (the operator addresses) is refused.
--   3. signup_mode 'open' allows, 'invite' allows an address with a pending,
--      unexpired account invitation, 'closed' refuses.
set lock_timeout = '2s';
set statement_timeout = '30s';

CREATE OR REPLACE FUNCTION kortix.before_user_created_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  policy record;
  v_provider text := coalesce(event #>> '{user,app_metadata,provider}', '');
  v_email text := lower(btrim(coalesce(event #>> '{user,email}', '')));
BEGIN
  SELECT signup_mode, reserved_emails INTO policy
  FROM kortix.self_host_signup_policy
  WHERE id;
  IF NOT FOUND OR v_provider LIKE 'sso:%' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF v_email <> '' AND v_email = ANY (policy.reserved_emails) THEN
    RETURN jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'This address belongs to the instance operator. The operator creates its account with `kortix self-host admin add`.'));
  END IF;

  IF policy.signup_mode = 'open' THEN
    RETURN '{}'::jsonb;
  END IF;

  IF policy.signup_mode = 'invite' AND v_email <> '' AND EXISTS (
    SELECT 1 FROM kortix.account_invitations i
    WHERE lower(i.email) = v_email AND i.accepted_at IS NULL AND i.expires_at > now()
  ) THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', CASE policy.signup_mode
      WHEN 'invite' THEN 'Sign-up on this instance is by invitation. Ask a workspace admin to invite this address.'
      ELSE 'Sign-up on this instance is closed.'
    END));
END;
$$;

REVOKE ALL ON FUNCTION kortix.before_user_created_hook(jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION kortix.before_user_created_hook(jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION kortix.before_user_created_hook(jsonb) FROM authenticated;
  END IF;
  -- GoTrue connects as supabase_auth_admin and calls the function by name.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA kortix TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION kortix.before_user_created_hook(jsonb) TO supabase_auth_admin;
  END IF;
END
$$;
