BEGIN;

-- Drop old agent-specific knowledge base tables
DROP TABLE IF EXISTS agent_knowledge_base_usage_log CASCADE;
DROP TABLE IF EXISTS agent_kb_file_processing_jobs CASCADE;
DROP TABLE IF EXISTS agent_knowledge_base_entries CASCADE;

-- User-level knowledge base folders
CREATE TABLE knowledge_base_folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT kb_folders_name_not_empty CHECK (LENGTH(TRIM(name)) > 0)
);

-- User-level knowledge base entries
CREATE TABLE knowledge_base_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    folder_id UUID NOT NULL REFERENCES knowledge_base_folders(folder_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    filename VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL, -- S3 path: knowledge-base/{folder_id}/{entry_id}/{filename}
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(255),
    
    -- LLM-generated summary for context
    summary TEXT NOT NULL,
    
    -- When to use this entry
    usage_context VARCHAR(100) DEFAULT 'always' CHECK (usage_context IN ('always', 'on_request', 'contextual')),
    
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT kb_entries_filename_not_empty CHECK (LENGTH(TRIM(filename)) > 0),
    CONSTRAINT kb_entries_summary_not_empty CHECK (LENGTH(TRIM(summary)) > 0),
    CONSTRAINT kb_entries_file_size_positive CHECK (file_size > 0)
);

-- Agent assignments to knowledge base folders
CREATE TABLE agent_knowledge_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    folder_id UUID NOT NULL REFERENCES knowledge_base_folders(folder_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(agent_id, folder_id)
);

-- Fine-grained agent assignments to specific knowledge base entries
CREATE TABLE agent_knowledge_entry_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    entry_id UUID NOT NULL REFERENCES knowledge_base_entries(entry_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    enabled BOOLEAN DEFAULT TRUE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(agent_id, entry_id)
);

-- Indexes
CREATE INDEX idx_kb_folders_account_id ON knowledge_base_folders(account_id);
CREATE INDEX idx_kb_entries_folder_id ON knowledge_base_entries(folder_id);
CREATE INDEX idx_kb_entries_account_id ON knowledge_base_entries(account_id);
CREATE INDEX idx_kb_assignments_agent_id ON agent_knowledge_assignments(agent_id);
CREATE INDEX idx_kb_assignments_folder_id ON agent_knowledge_assignments(folder_id);
CREATE INDEX idx_kb_entry_assignments_agent_id ON agent_knowledge_entry_assignments(agent_id);
CREATE INDEX idx_kb_entry_assignments_entry_id ON agent_knowledge_entry_assignments(entry_id);

-- RLS
ALTER TABLE knowledge_base_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_knowledge_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_knowledge_entry_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY kb_folders_account_access ON knowledge_base_folders
    FOR ALL USING (basejump.has_role_on_account(account_id) = true);

CREATE POLICY kb_entries_account_access ON knowledge_base_entries
    FOR ALL USING (basejump.has_role_on_account(account_id) = true);

CREATE POLICY kb_assignments_account_access ON agent_knowledge_assignments
    FOR ALL USING (basejump.has_role_on_account(account_id) = true);

CREATE POLICY kb_entry_assignments_account_access ON agent_knowledge_entry_assignments
    FOR ALL USING (basejump.has_role_on_account(account_id) = true);

-- Functions
CREATE OR REPLACE FUNCTION get_agent_knowledge_context(
    p_agent_id UUID
)
RETURNS TEXT
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    context_text TEXT := '';
    entry_record RECORD;
BEGIN
    FOR entry_record IN
        SELECT 
            kbe.filename,
            kbe.summary,
            kbf.name as folder_name
        FROM knowledge_base_entries kbe
        JOIN knowledge_base_folders kbf ON kbe.folder_id = kbf.folder_id
        JOIN agent_knowledge_assignments aka ON kbf.folder_id = aka.folder_id
        LEFT JOIN agent_knowledge_entry_assignments akea ON kbe.entry_id = akea.entry_id AND akea.agent_id = p_agent_id
        WHERE aka.agent_id = p_agent_id
        AND kbe.is_active = TRUE
        AND kbe.usage_context IN ('always', 'contextual')
        -- Include entry if: no specific assignment exists (folder-level) OR specific assignment is enabled
        AND (akea.entry_id IS NULL OR akea.enabled = TRUE)
        ORDER BY kbe.created_at DESC
    LOOP
        context_text := context_text || E'\n\n## ' || entry_record.folder_name || '/' || entry_record.filename || E'\n';
        context_text := context_text || entry_record.summary;
    END LOOP;
    
    RETURN CASE 
        WHEN context_text = '' THEN NULL
        ELSE E'# KNOWLEDGE BASE\n\nThe following files are available in your knowledge base:' || context_text
    END;
END;
$$;

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER kb_folders_updated_at
    BEFORE UPDATE ON knowledge_base_folders
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER kb_entries_updated_at
    BEFORE UPDATE ON knowledge_base_entries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Permissions
GRANT ALL ON knowledge_base_folders TO authenticated, service_role;
GRANT ALL ON knowledge_base_entries TO authenticated, service_role;
GRANT ALL ON agent_knowledge_assignments TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_agent_knowledge_context TO authenticated, service_role;

COMMIT;