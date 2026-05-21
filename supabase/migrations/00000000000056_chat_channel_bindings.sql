-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  chat_channel_bindings                                                      ║
-- ║                                                                            ║
-- ║  Tiny lookup table — only used in OAuth (multi-tenant Kortix Slack app)    ║
-- ║  mode so the shared /v1/webhooks/slack endpoint can translate Slack's      ║
-- ║  team_id into the Kortix project that owns the workspace.                  ║
-- ║                                                                            ║
-- ║  BYO mode (per-project Slack app) routes by URL                            ║
-- ║  (/v1/webhooks/slack/:projectId) and skips this table entirely.            ║
-- ║                                                                            ║
-- ║  All other channel state — bot tokens, signing secrets, team metadata —    ║
-- ║  lives in kortix.project_secrets so it gets injected as env vars at        ║
-- ║  sandbox spawn. This table holds nothing sensitive.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS kortix.chat_channel_bindings (
  binding_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  platform      varchar(32) NOT NULL,
  workspace_id  varchar(128) NOT NULL,
  installed_at  timestamptz NOT NULL DEFAULT now()
);

-- One Slack/Discord/… workspace can only bind to one Kortix project; if a
-- workspace re-installs to a different project the OAuth callback issues an
-- UPSERT against this index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_channel_bindings_workspace
  ON kortix.chat_channel_bindings (platform, workspace_id);

-- Reverse lookup — useful for "which workspaces does this project own?"
-- queries from the dashboard.
CREATE INDEX IF NOT EXISTS idx_chat_channel_bindings_project
  ON kortix.chat_channel_bindings (project_id);
