-- Flip accounts.iam_v2_enabled default to TRUE so every new account
-- starts on the simplified V2 IAM model. Existing rows keep whatever
-- value the per-account migration left in place — this only changes
-- the default for INSERTs that don't specify the column.
--
-- Idempotent.

ALTER TABLE "kortix"."accounts"
  ALTER COLUMN "iam_v2_enabled" SET DEFAULT true;
