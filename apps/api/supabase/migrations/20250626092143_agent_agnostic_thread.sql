-- Migration: Make threads agent-agnostic with proper agent versioning support
-- This migration enables per-message agent selection with version tracking

BEGIN;

-- Add agent version tracking to messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_version_id UUID REFERENCES agent_versions(version_id) ON DELETE SET NULL;

-- Create indexes for message agent queries
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent_version_id ON messages(agent_version_id);

-- Comments on the new columns
COMMENT ON COLUMN messages.agent_id IS 'ID of the agent that generated this message. For user messages, this represents the agent that should respond to this message.';
COMMENT ON COLUMN messages.agent_version_id IS 'Specific version of the agent used for this message. This is the actual configuration that was active.';

-- Update comment on thread agent_id to reflect new agent-agnostic approach
COMMENT ON COLUMN threads.agent_id IS 'Optional default agent for the thread. If NULL, agent can be selected per message. Threads are now agent-agnostic.';

-- Add agent version tracking to agent_runs
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS agent_version_id UUID REFERENCES agent_versions(version_id) ON DELETE SET NULL;

-- Create indexes for agent run queries
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_version_id ON agent_runs(agent_version_id);

-- Comments on the agent_runs columns
COMMENT ON COLUMN agent_runs.agent_id IS 'ID of the agent used for this specific agent run.';
COMMENT ON COLUMN agent_runs.agent_version_id IS 'Specific version of the agent used for this run. This tracks the exact configuration.';

COMMIT; 