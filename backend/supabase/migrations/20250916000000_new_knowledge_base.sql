BEGIN;

-- Drop old agent-specific knowledge base tables
DROP TABLE IF EXISTS agent_knowledge_base_usage_log CASCADE;
DROP TABLE IF EXISTS agent_kb_file_processing_jobs CASCADE;
DROP TABLE IF EXISTS agent_knowledge_base_entries CASCADE;
DROP TABLE IF EXISTS agent_knowledge_assignments CASCADE;

-- User-level knowledge base folders
CREATE TABLE IF NOT EXISTS knowledge_base_folders (
    folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    CONSTRAINT kb_folders_name_not_empty CHECK (LENGTH(TRIM(name)) > 0)
);

-- User-level knowledge base entries
CREATE TABLE IF NOT EXISTS knowledge_base_entries (
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

-- Agent assignments to specific knowledge base entries
CREATE TABLE IF NOT EXISTS agent_knowledge_entry_assignments (
    assignment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    entry_id UUID NOT NULL REFERENCES knowledge_base_entries(entry_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    enabled BOOLEAN DEFAULT TRUE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(agent_id, entry_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_kb_folders_account_id ON knowledge_base_folders(account_id);
CREATE INDEX IF NOT EXISTS idx_kb_entries_folder_id ON knowledge_base_entries(folder_id);
CREATE INDEX IF NOT EXISTS idx_kb_entries_account_id ON knowledge_base_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_kb_entry_assignments_agent_id ON agent_knowledge_entry_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_kb_entry_assignments_entry_id ON agent_knowledge_entry_assignments(entry_id);

-- RLS
ALTER TABLE knowledge_base_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_knowledge_entry_assignments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_folders_account_access' AND tablename = 'knowledge_base_folders') THEN
        CREATE POLICY kb_folders_account_access ON knowledge_base_folders
            FOR ALL USING (basejump.has_role_on_account(account_id) = true);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_entries_account_access' AND tablename = 'knowledge_base_entries') THEN
        CREATE POLICY kb_entries_account_access ON knowledge_base_entries
            FOR ALL USING (basejump.has_role_on_account(account_id) = true);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'kb_entry_assignments_account_access' AND tablename = 'agent_knowledge_entry_assignments') THEN
        CREATE POLICY kb_entry_assignments_account_access ON agent_knowledge_entry_assignments
            FOR ALL USING (basejump.has_role_on_account(account_id) = true);
    END IF;
END $$;

-- Functions
-- Drop the old version of the function first to avoid signature conflicts
DROP FUNCTION IF EXISTS get_agent_knowledge_base_context(UUID);
DROP FUNCTION IF EXISTS get_agent_knowledge_base_context(UUID, INTEGER);

CREATE OR REPLACE FUNCTION get_agent_knowledge_base_context(
    p_agent_id UUID,
    p_max_tokens INTEGER DEFAULT 4000
)
RETURNS TEXT
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    context_text TEXT := '';
    entry_record RECORD;
    current_length INTEGER := 0;
    estimated_tokens INTEGER;
BEGIN
    FOR entry_record IN
        SELECT 
            kbe.filename,
            kbe.summary,
            kbf.name as folder_name
        FROM knowledge_base_entries kbe
        JOIN knowledge_base_folders kbf ON kbe.folder_id = kbf.folder_id
        JOIN agent_knowledge_entry_assignments akea ON kbe.entry_id = akea.entry_id
        WHERE akea.agent_id = p_agent_id
        AND akea.enabled = TRUE
        AND kbe.is_active = TRUE
        AND kbe.usage_context IN ('always', 'contextual')
        ORDER BY kbe.created_at DESC
    LOOP
        -- Rough token estimation: ~4 characters per token
        estimated_tokens := (current_length + LENGTH(entry_record.filename) + LENGTH(entry_record.summary) + 50) / 4;
        
        -- Stop if we'd exceed max tokens
        IF estimated_tokens > p_max_tokens THEN
            EXIT;
        END IF;
        
        context_text := context_text || E'\n\n## ' || entry_record.folder_name || '/' || entry_record.filename || E'\n';
        context_text := context_text || entry_record.summary;
        current_length := LENGTH(context_text);
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

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kb_folders_updated_at') THEN
        CREATE TRIGGER kb_folders_updated_at
            BEFORE UPDATE ON knowledge_base_folders
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'kb_entries_updated_at') THEN
        CREATE TRIGGER kb_entries_updated_at
            BEFORE UPDATE ON knowledge_base_entries
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Permissions
GRANT ALL ON knowledge_base_folders TO authenticated, service_role;
GRANT ALL ON knowledge_base_entries TO authenticated, service_role;
GRANT ALL ON agent_knowledge_entry_assignments TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_agent_knowledge_base_context(UUID, INTEGER) TO authenticated, service_role;

COMMIT;