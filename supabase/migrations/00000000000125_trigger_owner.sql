-- Trigger owner: the project member a trigger's automated sessions run AS.
--
-- A `per_user` connector resolves credentials per acting user. Triggers (cron /
-- webhook / manual) used to ALWAYS run as the account owner, so a per_user
-- connector in a scheduled run only resolved if that exact owner had personally
-- connected — the root of "my connector isn't available in my scheduled run".
-- With an owner, the trigger's session runs as that member, so a per_user
-- connector uses THEIR connected accounts ("my email-triage cron uses my Gmail").
--
-- Stored here (platform DB), NOT in the portable repo manifest: a user_id is
-- account-specific and must not live in committed kortix.toml. NULL = fall back
-- to the account owner (legacy behavior) — so existing triggers are unaffected,
-- and an owner who later leaves the account falls back automatically.
ALTER TABLE "kortix"."project_trigger_runtime"
  ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;

CREATE INDEX IF NOT EXISTS "idx_project_trigger_runtime_owner_user"
  ON "kortix"."project_trigger_runtime" ("owner_user_id");
