-- Personal MCP server connections per user.
-- Allows users to register their own MCP servers that get injected
-- into their agent sessions automatically.

CREATE TABLE IF NOT EXISTS kortix.personal_mcp_servers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  headers     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personal_mcp_servers_user
  ON kortix.personal_mcp_servers(user_id);

-- RLS: users can only read/write their own rows
ALTER TABLE kortix.personal_mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY personal_mcp_servers_owner ON kortix.personal_mcp_servers
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
