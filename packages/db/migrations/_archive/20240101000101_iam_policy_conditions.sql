-- Policy conditions: extra checks applied after scope + role match. The
-- engine evaluates each key in the JSONB and requires ALL configured
-- conditions to pass. Unknown keys are ignored, so forward-compat is safe.
--
-- Supported keys (v1):
--   ip_cidrs:    text[] — request IP must fall in one of these
--   require_mfa: bool   — JWT must be AAL2 (MFA step-up)
--
-- Defaults to '{}' (no conditions) so every existing policy keeps its
-- semantics. Idempotent.

ALTER TABLE "kortix"."iam_policies"
  ADD COLUMN IF NOT EXISTS "conditions" jsonb DEFAULT '{}'::jsonb NOT NULL;
