BEGIN;

-- Create agents table for storing agent configurations
CREATE TABLE IF NOT EXISTS agents (
    agent_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    configured_mcps JSONB DEFAULT '[]'::jsonb,
    agentpress_tools JSONB DEFAULT '{}'::jsonb,
    is_default BOOLEAN DEFAULT false,
    avatar VARCHAR(10),
    avatar_color VARCHAR(7),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add indexes for performance on agents table
CREATE INDEX IF NOT EXISTS idx_agents_account_id ON agents(account_id);
CREATE INDEX IF NOT EXISTS idx_agents_is_default ON agents(is_default);
CREATE INDEX IF NOT EXISTS idx_agents_created_at ON agents(created_at);

-- Add unique constraint to ensure only one default agent per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_account_default ON agents(account_id, is_default) WHERE is_default = true;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_agents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at (drop first if exists to avoid conflicts)
DROP TRIGGER IF EXISTS trigger_agents_updated_at ON agents;
CREATE TRIGGER trigger_agents_updated_at
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION update_agents_updated_at();

-- Enable RLS on agents table
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist to avoid conflicts
DROP POLICY IF EXISTS agents_select_own ON agents;
DROP POLICY IF EXISTS agents_insert_own ON agents;
DROP POLICY IF EXISTS agents_update_own ON agents;
DROP POLICY IF EXISTS agents_delete_own ON agents;

-- Policy for users to see their own agents
CREATE POLICY agents_select_own ON agents
    FOR SELECT
    USING (basejump.has_role_on_account(account_id));

-- Policy for users to insert their own agents
CREATE POLICY agents_insert_own ON agents
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id, 'owner'));

-- Policy for users to update their own agents
CREATE POLICY agents_update_own ON agents
    FOR UPDATE
    USING (basejump.has_role_on_account(account_id, 'owner'));

-- Policy for users to delete their own agents (except default)
CREATE POLICY agents_delete_own ON agents
    FOR DELETE
    USING (basejump.has_role_on_account(account_id, 'owner') AND is_default = false);

-- NOTE: Default agent insertion has been removed per requirement

-- Add agent_id column to threads table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='threads' AND column_name='agent_id') THEN
        ALTER TABLE threads ADD COLUMN agent_id UUID REFERENCES agents(agent_id) ON DELETE SET NULL;
        CREATE INDEX idx_threads_agent_id ON threads(agent_id);
        COMMENT ON COLUMN threads.agent_id IS 'ID of the agent used for this conversation thread. If NULL, uses account default agent.';
    END IF;
END $$;

-- Update existing threads to leave agent_id NULL (no default agents inserted)
-- (Optional: if you prefer to leave existing threads with NULL agent_id, this step can be omitted.)
-- UPDATE threads 
-- SET agent_id = NULL
-- WHERE agent_id IS NULL;

COMMIT;
