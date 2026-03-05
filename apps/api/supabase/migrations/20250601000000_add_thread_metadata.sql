-- Add metadata column to threads table to store additional context
ALTER TABLE threads ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Create index for metadata queries
CREATE INDEX IF NOT EXISTS idx_threads_metadata ON threads USING GIN (metadata);

-- Comment on the column
COMMENT ON COLUMN threads.metadata IS 'Stores additional thread context like agent builder mode and target agent';

-- Add agent_id to messages table to support per-message agent selection
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;

-- Create index for message agent queries
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);

-- Comment on the new column
COMMENT ON COLUMN messages.agent_id IS 'ID of the agent that generated this message. For user messages, this represents the agent that should respond to this message.';

-- Make thread agent_id nullable to allow agent-agnostic threads
-- This is already nullable from the existing migration, but we'll add a comment
COMMENT ON COLUMN threads.agent_id IS 'Optional default agent for the thread. If NULL, agent can be selected per message.'; 