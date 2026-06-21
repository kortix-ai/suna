-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  Channel Tables Migration                                                  ║
-- ║                                                                            ║
-- ║  Creates the channel_configs table and supporting enums.                   ║
-- ║  This is the ONLY channel table — credentials live in sandbox env vars,    ║
-- ║  messages/sessions are managed by the opencode-channels runtime.           ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- ─── Enums ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE kortix.channel_type AS ENUM (
    'telegram', 'slack', 'discord',
    'whatsapp', 'teams', 'voice', 'email', 'sms'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE kortix.session_strategy AS ENUM (
    'single', 'per-thread', 'per-user', 'per-message'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── channel_configs ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kortix.channel_configs (
  channel_config_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL,
  sandbox_id         uuid REFERENCES kortix.sandboxes (sandbox_id) ON DELETE SET NULL,
  channel_type       kortix.channel_type NOT NULL,
  name               varchar(255) NOT NULL,
  enabled            boolean NOT NULL DEFAULT true,
  platform_config    jsonb NOT NULL DEFAULT '{}'::jsonb,
  session_strategy   kortix.session_strategy NOT NULL DEFAULT 'per-thread',
  system_prompt      text,
  agent_name         varchar(255),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_account
  ON kortix.channel_configs (account_id);
CREATE INDEX IF NOT EXISTS idx_channel_configs_sandbox
  ON kortix.channel_configs (sandbox_id);
CREATE INDEX IF NOT EXISTS idx_channel_configs_type
  ON kortix.channel_configs (channel_type);

-- ─── Grants ─────────────────────────────────────────────────────────────────

GRANT ALL ON kortix.channel_configs TO service_role;

-- ─── Cleanup legacy tables ──────────────────────────────────────────────────

DROP TABLE IF EXISTS kortix.channel_messages CASCADE;
DROP TABLE IF EXISTS kortix.channel_sessions CASCADE;
DROP TABLE IF EXISTS kortix.channel_platform_credentials CASCADE;
