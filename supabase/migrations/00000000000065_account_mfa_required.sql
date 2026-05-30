-- Account-wide MFA enforcement. When mfa_required is true the IAM engine
-- denies every user-session (JWT) request whose aal claim is not 'aal2'.
-- Super-admins and PATs are exempt — PATs gate through per-policy
-- conditions (require_mfa); super-admins bypass so the switch can't
-- permanently lock an account out.
--
-- Defaults to false so existing accounts keep working unchanged.
-- Idempotent.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "mfa_required" boolean DEFAULT false NOT NULL;
