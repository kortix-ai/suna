-- Create agent_default_files table for storing default file metadata
CREATE TABLE IF NOT EXISTS agent_default_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agent_config(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    size BIGINT NOT NULL,
    mime_type TEXT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    uploaded_by UUID REFERENCES auth.users(id),
    
    -- Ensure unique filenames per agent
    UNIQUE(agent_id, name)
);

-- Create indexes for better query performance
CREATE INDEX idx_agent_default_files_agent_id ON agent_default_files(agent_id);
CREATE INDEX idx_agent_default_files_account_id ON agent_default_files(account_id);

-- Enable RLS
ALTER TABLE agent_default_files ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Users can view files for agents in their accounts
CREATE POLICY "Users can view agent default files in their accounts" ON agent_default_files
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_accounts
            WHERE user_accounts.account_id = agent_default_files.account_id
            AND user_accounts.user_id = auth.uid()
        )
    );

-- Only account owners can insert files
CREATE POLICY "Account owners can upload agent default files" ON agent_default_files
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = agent_default_files.account_id
            AND accounts.owner = auth.uid()
        )
    );

-- Only account owners can update files
CREATE POLICY "Account owners can update agent default files" ON agent_default_files
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = agent_default_files.account_id
            AND accounts.owner = auth.uid()
        )
    );

-- Only account owners can delete files
CREATE POLICY "Account owners can delete agent default files" ON agent_default_files
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM accounts
            WHERE accounts.id = agent_default_files.account_id
            AND accounts.owner = auth.uid()
        )
    );

-- Grant permissions
GRANT ALL ON agent_default_files TO authenticated;
GRANT ALL ON agent_default_files TO service_role;
