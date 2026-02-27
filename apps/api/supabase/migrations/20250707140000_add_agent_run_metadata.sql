-- Migration: Add streaming parameters to agent_runs table
-- This migration adds a metadata field to track the exact parameters 
-- used for each agent run

BEGIN;

-- Add metadata column to agent_runs table for streaming configuration
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Create index for metadata queries (useful for filtering by model, etc.)
CREATE INDEX IF NOT EXISTS idx_agent_runs_metadata ON agent_runs USING GIN (metadata);

-- Add comment to document the metadata column
COMMENT ON COLUMN agent_runs.metadata IS 'Streaming and configuration parameters for this agent run (model_name, enable_thinking, reasoning_effort, etc.)';

COMMIT; 