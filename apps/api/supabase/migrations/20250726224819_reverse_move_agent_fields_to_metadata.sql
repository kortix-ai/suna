-- Reverse Migration: Move agent_id and agent_version_id back from metadata to dedicated columns
-- This reverses the changes made in 20250726223759_move_agent_fields_to_metadata.sql

BEGIN;

-- Step 1: Add back the dedicated agent columns with proper foreign key constraints
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS agent_version_id UUID REFERENCES agent_versions(version_id) ON DELETE SET NULL;

-- Step 2: Extract agent info from metadata and populate the dedicated columns
-- Only update messages that have agent info in metadata
UPDATE messages 
SET 
    agent_id = CASE 
        WHEN metadata ? 'agent_id' THEN (metadata->>'agent_id')::UUID 
        ELSE NULL 
    END,
    agent_version_id = CASE 
        WHEN metadata ? 'agent_version_id' THEN (metadata->>'agent_version_id')::UUID 
        ELSE NULL 
    END
WHERE metadata ? 'agent_id' OR metadata ? 'agent_version_id';

-- Step 3: Remove agent fields from metadata
UPDATE messages 
SET metadata = metadata - 'agent_id' - 'agent_version_id'
WHERE metadata ? 'agent_id' OR metadata ? 'agent_version_id';

-- Step 4: Recreate the indexes on the agent columns
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_agent_version_id ON messages(agent_version_id);

-- Step 5: Update the comment to reflect the original structure
COMMENT ON COLUMN messages.metadata IS 'JSONB metadata for message-specific data (agent info stored in dedicated columns)';

COMMIT; 