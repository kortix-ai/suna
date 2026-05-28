-- PAT (CLI Personal Access Token) lifecycle policy per account.
-- All three flags independent; admins can mix any combination.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "pat_max_lifetime_days" integer,
  ADD COLUMN IF NOT EXISTS "pat_require_expiry"   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "pat_idle_revoke_days" integer;
