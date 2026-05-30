-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  chat_installs  +  chat_channel_bindings restructure                       ║
-- ║                                                                            ║
-- ║  Multi-project per workspace. One Slack workspace can serve N Kortix       ║
-- ║  projects, so routing splits into two questions:                           ║
-- ║                                                                            ║
-- ║    chat_installs          which projects connected this workspace          ║
-- ║                           (workspace ↔ project membership)                ║
-- ║    chat_channel_bindings  which project owns a specific channel            ║
-- ║                           (per-channel routing, bound lazily on first use) ║
-- ║                                                                            ║
-- ║  The bot token still lives in kortix.project_secrets (fanned out to every  ║
-- ║  project on the workspace by the OAuth callback). This table holds no      ║
-- ║  secrets.                                                                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── chat_installs ────────────────────────────────────────────────────────────
-- One row per (workspace, project) the workspace was connected to. Answers
-- "how many projects could an event in this workspace belong to" — the input
-- to the auto-bind-if-single / show-a-picker-if-many decision.
CREATE TABLE IF NOT EXISTS kortix.chat_installs (
  install_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform      varchar(32) NOT NULL,
  workspace_id  varchar(128) NOT NULL,
  project_id    uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  connected_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_installs_workspace_project
  ON kortix.chat_installs (platform, workspace_id, project_id);

CREATE INDEX IF NOT EXISTS idx_chat_installs_workspace
  ON kortix.chat_installs (platform, workspace_id);

CREATE INDEX IF NOT EXISTS idx_chat_installs_project
  ON kortix.chat_installs (project_id);

-- ── chat_channel_bindings → per-channel routing ──────────────────────────────
-- Now keyed by (platform, workspace_id, channel_id). project_id becomes
-- nullable: a NULL row means a project picker has been posted in that channel
-- and is awaiting a click.
DROP INDEX IF EXISTS kortix.idx_chat_channel_bindings_workspace;

-- ONE-TIME data migration of the OLD (workspace-keyed) rows. Runs ONLY while
-- the table is still in its pre-migration shape (no channel_id column yet).
-- The schema runner re-executes every migration file on each boot, so without
-- this guard the unconditional DELETE below would wipe live per-channel
-- routing rows on every restart. Guarding on the column's absence makes the
-- destructive step idempotent (it never runs again once the column exists).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'kortix'
      AND table_name = 'chat_channel_bindings'
      AND column_name = 'channel_id'
  ) THEN
    -- Existing rows were keyed (platform, workspace_id) by the old single-project
    -- OAuth callback — they are workspace↔project memberships, not channel
    -- bindings. Migrate them into chat_installs, then clear the table so it can
    -- be repurposed cleanly (it now means per-channel, not per-workspace).
    INSERT INTO kortix.chat_installs (platform, workspace_id, project_id, connected_at)
      SELECT platform, workspace_id, project_id, installed_at
      FROM kortix.chat_channel_bindings
    ON CONFLICT DO NOTHING;

    DELETE FROM kortix.chat_channel_bindings;
  END IF;
END $$;

ALTER TABLE kortix.chat_channel_bindings
  ADD COLUMN IF NOT EXISTS channel_id   varchar(128),
  ADD COLUMN IF NOT EXISTS channel_name varchar(256),
  ADD COLUMN IF NOT EXISTS channel_type varchar(32),
  ADD COLUMN IF NOT EXISTS picker_ts    varchar(64);

ALTER TABLE kortix.chat_channel_bindings ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE kortix.chat_channel_bindings ALTER COLUMN channel_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channel_bindings_channel
  ON kortix.chat_channel_bindings (platform, workspace_id, channel_id);
