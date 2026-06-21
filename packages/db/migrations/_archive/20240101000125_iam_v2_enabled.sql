-- IAM V2 rollout flag. Per-account boolean — when true the engine
-- evaluates access against the simplified V2 model (fixed role table,
-- account_members + project_members + project_group_grants) and ignores
-- iam_policies entirely. False = legacy V1 path (iam_policies + scopes
-- + custom roles + deny precedence).
--
-- Default false so existing accounts keep working unchanged. The flip
-- happens per-account once the migration script has validated that
-- "every action V1 allows, V2 also allows".
--
-- Idempotent.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "iam_v2_enabled" boolean NOT NULL DEFAULT false;
