-- Keep the Supabase/boot migration stream aligned with the Drizzle schema.
-- The Slack channel selection code reads these optional overrides from
-- chat_channel_bindings. Dev/prod databases that only applied the legacy
-- Supabase migrations can miss the Drizzle-only 20260616161826 migration and
-- crash async Slack dispatch after adding the hourglass reaction.

ALTER TABLE "kortix"."chat_channel_bindings"
  ADD COLUMN IF NOT EXISTS "agent_name" varchar(128),
  ADD COLUMN IF NOT EXISTS "opencode_model" varchar(128);

