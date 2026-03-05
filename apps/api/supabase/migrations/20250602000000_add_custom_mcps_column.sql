BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS custom_mcps JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_agents_custom_mcps ON agents USING GIN (custom_mcps);

COMMENT ON COLUMN agents.custom_mcps IS 'Stores custom MCP server configurations added by users (JSON or SSE endpoints)';

COMMIT; 