BEGIN;

CREATE TABLE IF NOT EXISTS knowledge_base_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    name VARCHAR(255) NOT NULL,
    description TEXT,
    
    content TEXT NOT NULL,
    content_tokens INTEGER, -- Token count for content management
    
    usage_context VARCHAR(100) DEFAULT 'always', -- 'always', 'on_request', 'contextual'
    
    is_active BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ,

    CONSTRAINT kb_entries_valid_usage_context CHECK (
        usage_context IN ('always', 'on_request', 'contextual')
    ),
    CONSTRAINT kb_entries_content_not_empty CHECK (
        content IS NOT NULL AND LENGTH(TRIM(content)) > 0
    )
);


CREATE TABLE IF NOT EXISTS knowledge_base_usage_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID NOT NULL REFERENCES knowledge_base_entries(entry_id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,

    usage_type VARCHAR(50) NOT NULL, -- 'context_injection', 'manual_reference'
    tokens_used INTEGER, -- How many tokens were used
    
    -- Timestamps
    used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kb_entries_thread_id ON knowledge_base_entries(thread_id);
CREATE INDEX IF NOT EXISTS idx_kb_entries_account_id ON knowledge_base_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_kb_entries_is_active ON knowledge_base_entries(is_active);
CREATE INDEX IF NOT EXISTS idx_kb_entries_usage_context ON knowledge_base_entries(usage_context);
CREATE INDEX IF NOT EXISTS idx_kb_entries_created_at ON knowledge_base_entries(created_at);

CREATE INDEX IF NOT EXISTS idx_kb_usage_entry_id ON knowledge_base_usage_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_kb_usage_thread_id ON knowledge_base_usage_log(thread_id);
CREATE INDEX IF NOT EXISTS idx_kb_usage_used_at ON knowledge_base_usage_log(used_at);

ALTER TABLE knowledge_base_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY kb_entries_user_access ON knowledge_base_entries
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM threads t
            LEFT JOIN projects p ON t.project_id = p.project_id
            WHERE t.thread_id = knowledge_base_entries.thread_id
            AND (
                basejump.has_role_on_account(t.account_id) = true OR 
                basejump.has_role_on_account(p.account_id) = true OR
                basejump.has_role_on_account(knowledge_base_entries.account_id) = true
            )
        )
    );

CREATE POLICY kb_usage_log_user_access ON knowledge_base_usage_log
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM threads t
            LEFT JOIN projects p ON t.project_id = p.project_id
            WHERE t.thread_id = knowledge_base_usage_log.thread_id
            AND (
                basejump.has_role_on_account(t.account_id) = true OR 
                basejump.has_role_on_account(p.account_id) = true
            )
        )
    );

CREATE OR REPLACE FUNCTION get_thread_knowledge_base(
    p_thread_id UUID,
    p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    entry_id UUID,
    name VARCHAR(255),
    description TEXT,
    content TEXT,
    usage_context VARCHAR(100),
    is_active BOOLEAN,
    created_at TIMESTAMPTZ
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        kbe.entry_id,
        kbe.name,
        kbe.description,
        kbe.content,
        kbe.usage_context,
        kbe.is_active,
        kbe.created_at
    FROM knowledge_base_entries kbe
    WHERE kbe.thread_id = p_thread_id
    AND (p_include_inactive OR kbe.is_active = TRUE)
    ORDER BY kbe.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_knowledge_base_context(
    p_thread_id UUID,
    p_max_tokens INTEGER DEFAULT 4000
)
RETURNS TEXT
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    context_text TEXT := '';
    entry_record RECORD;
    current_tokens INTEGER := 0;
    estimated_tokens INTEGER;
BEGIN
    FOR entry_record IN
        SELECT 
            name,
            description,
            content,
            content_tokens
        FROM knowledge_base_entries
        WHERE thread_id = p_thread_id
        AND is_active = TRUE
        AND usage_context IN ('always', 'contextual')
        ORDER BY created_at DESC
    LOOP
        estimated_tokens := COALESCE(entry_record.content_tokens, LENGTH(entry_record.content) / 4);
        
        IF current_tokens + estimated_tokens > p_max_tokens THEN
            EXIT;
        END IF;
        
        context_text := context_text || E'\n\n## Knowledge Base: ' || entry_record.name || E'\n';
        
        IF entry_record.description IS NOT NULL AND entry_record.description != '' THEN
            context_text := context_text || entry_record.description || E'\n\n';
        END IF;
        
        context_text := context_text || entry_record.content;
        
        current_tokens := current_tokens + estimated_tokens;
        
        INSERT INTO knowledge_base_usage_log (entry_id, thread_id, usage_type, tokens_used)
        SELECT entry_id, p_thread_id, 'context_injection', estimated_tokens
        FROM knowledge_base_entries
        WHERE thread_id = p_thread_id AND name = entry_record.name
        LIMIT 1;
    END LOOP;
    
    RETURN CASE 
        WHEN context_text = '' THEN NULL
        ELSE E'# KNOWLEDGE BASE CONTEXT\n\nThe following information is from your knowledge base and should be used as reference when responding to the user:' || context_text
    END;
END;
$$;

CREATE OR REPLACE FUNCTION update_kb_entry_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    IF NEW.content != OLD.content THEN
        NEW.content_tokens = LENGTH(NEW.content) / 4;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_kb_entries_updated_at
    BEFORE UPDATE ON knowledge_base_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_kb_entry_timestamp();

CREATE OR REPLACE FUNCTION calculate_kb_entry_tokens()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content_tokens = LENGTH(NEW.content) / 4;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_kb_entries_calculate_tokens
    BEFORE INSERT ON knowledge_base_entries
    FOR EACH ROW
    EXECUTE FUNCTION calculate_kb_entry_tokens();

GRANT ALL PRIVILEGES ON TABLE knowledge_base_entries TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE knowledge_base_usage_log TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION get_thread_knowledge_base TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_knowledge_base_context TO authenticated, service_role;

COMMENT ON TABLE knowledge_base_entries IS 'Stores manual knowledge base entries for threads, similar to ChatGPT custom instructions';
COMMENT ON TABLE knowledge_base_usage_log IS 'Logs when and how knowledge base entries are used';

COMMENT ON FUNCTION get_thread_knowledge_base IS 'Retrieves all knowledge base entries for a specific thread';
COMMENT ON FUNCTION get_knowledge_base_context IS 'Generates knowledge base context text for agent prompts';

COMMIT;