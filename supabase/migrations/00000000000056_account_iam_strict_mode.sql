-- Strict IAM mode toggle per account. When true the engine ignores legacy
-- account_role + project_members bridges; only super-admin bypass and
-- explicit IAM policies grant access. Defaults to false so existing
-- accounts continue to work unchanged. Idempotent — safe to re-run.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "iam_strict_mode" boolean DEFAULT false NOT NULL;
