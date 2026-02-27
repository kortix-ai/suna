-- Migration: Remove agent_id and agent_version_id from threads table
-- This makes threads truly agent-agnostic - agent selection is handled only through agent/initiate and agent/start endpoints

BEGIN;

-- Drop indexes first
DROP INDEX IF EXISTS idx_threads_agent_id;
DROP INDEX IF EXISTS idx_threads_agent_version;

-- Remove agent_id column from threads table
ALTER TABLE threads DROP COLUMN IF EXISTS agent_id;

-- Remove agent_version_id column from threads table  
ALTER TABLE threads DROP COLUMN IF EXISTS agent_version_id;

-- Update comment to reflect that threads are now completely agent-agnostic
COMMENT ON TABLE threads IS 'Conversation threads - completely agent-agnostic. Agent selection handled via /agent/initiate and /agent/start endpoints.';

COMMIT; 