-- Migration: Move agent_id and agent_version_id from dedicated columns to metadata
-- This improves storage efficiency by only storing agent info for assistant messages where it's relevant

BEGIN;

-- Step 1: Update existing messages to move agent info to metadata
-- Only update messages that have agent_id or agent_version_id set
UPDATE messages 
SET metadata = jsonb_set(
    jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{agent_id}',
        to_jsonb(agent_id)
    ),
    '{agent_version_id}',
    to_jsonb(agent_version_id)
)
WHERE agent_id IS NOT NULL OR agent_version_id IS NOT NULL;

-- Step 2: Drop indexes on the columns we're about to remove
DROP INDEX IF EXISTS idx_messages_agent_id;
DROP INDEX IF EXISTS idx_messages_agent_version_id;

-- Step 3: Drop the dedicated agent columns
ALTER TABLE messages DROP COLUMN IF EXISTS agent_id;
ALTER TABLE messages DROP COLUMN IF EXISTS agent_version_id;

-- Step 4: Add comment explaining the new structure
COMMENT ON COLUMN messages.metadata IS 'JSONB metadata including agent_id and agent_version_id for assistant messages, and other message-specific data';

COMMIT; 