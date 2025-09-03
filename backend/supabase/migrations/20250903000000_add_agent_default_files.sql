BEGIN;

-- Create agent_default_files table for storing default file metadata
CREATE TABLE IF NOT EXISTS agent_default_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    size BIGINT NOT NULL,
    mime_type TEXT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    uploaded_by UUID REFERENCES auth.users(id),
    
    -- Ensure unique filenames per agent
    CONSTRAINT agent_default_files_unique_name_per_agent UNIQUE(agent_id, name),
    
    -- Ensure valid file names
    CONSTRAINT agent_default_files_name_not_empty CHECK (
        name IS NOT NULL AND LENGTH(TRIM(name)) > 0
    ),
    
    -- Ensure valid storage path
    CONSTRAINT agent_default_files_storage_path_not_empty CHECK (
        storage_path IS NOT NULL AND LENGTH(TRIM(storage_path)) > 0
    ),
    
    -- Ensure valid file size
    CONSTRAINT agent_default_files_size_positive CHECK (size > 0)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_agent_default_files_agent_id ON agent_default_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_default_files_account_id ON agent_default_files(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_default_files_uploaded_at ON agent_default_files(uploaded_at);

-- Enable RLS
ALTER TABLE agent_default_files ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for agent default files (following the pattern from agent_llamacloud_knowledge_bases)
CREATE POLICY agent_default_files_user_access ON agent_default_files
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM agents a
            WHERE a.agent_id = agent_default_files.agent_id
            AND basejump.has_role_on_account(a.account_id) = true
        )
    );

-- Create trigger for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_agent_default_files_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.uploaded_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_default_files_updated_at
    BEFORE UPDATE ON agent_default_files
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_default_files_timestamp();

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE agent_default_files TO authenticated, service_role;

-- Add comments
COMMENT ON TABLE agent_default_files IS 'Stores default files that are automatically available in every chat session for an agent';
COMMENT ON COLUMN agent_default_files.agent_id IS 'Reference to the agent that owns these default files';
COMMENT ON COLUMN agent_default_files.storage_path IS 'Path in Supabase storage where the file is stored';
COMMENT ON COLUMN agent_default_files.size IS 'File size in bytes';

COMMIT;