BEGIN;

-- Create separate table for agent-specific knowledge base entries
CREATE TABLE IF NOT EXISTS agent_knowledge_base_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
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

    CONSTRAINT agent_kb_entries_valid_usage_context CHECK (
        usage_context IN ('always', 'on_request', 'contextual')
    ),
    CONSTRAINT agent_kb_entries_content_not_empty CHECK (
        content IS NOT NULL AND LENGTH(TRIM(content)) > 0
    )
);

-- Create usage log table for agent knowledge base
CREATE TABLE IF NOT EXISTS agent_knowledge_base_usage_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id UUID NOT NULL REFERENCES agent_knowledge_base_entries(entry_id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,

    usage_type VARCHAR(50) NOT NULL, -- 'context_injection', 'manual_reference'
    tokens_used INTEGER, -- How many tokens were used
    
    -- Timestamps
    used_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_agent_id ON agent_knowledge_base_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_account_id ON agent_knowledge_base_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_is_active ON agent_knowledge_base_entries(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_usage_context ON agent_knowledge_base_entries(usage_context);
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_created_at ON agent_knowledge_base_entries(created_at);

CREATE INDEX IF NOT EXISTS idx_agent_kb_usage_entry_id ON agent_knowledge_base_usage_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_agent_kb_usage_agent_id ON agent_knowledge_base_usage_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_kb_usage_used_at ON agent_knowledge_base_usage_log(used_at);

-- Enable RLS
ALTER TABLE agent_knowledge_base_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_knowledge_base_usage_log ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for agent knowledge base entries
CREATE POLICY agent_kb_entries_user_access ON agent_knowledge_base_entries
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM agents a
            WHERE a.agent_id = agent_knowledge_base_entries.agent_id
            AND basejump.has_role_on_account(a.account_id) = true
        )
    );

-- Create RLS policies for agent knowledge base usage log
CREATE POLICY agent_kb_usage_log_user_access ON agent_knowledge_base_usage_log
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM agents a
            WHERE a.agent_id = agent_knowledge_base_usage_log.agent_id
            AND basejump.has_role_on_account(a.account_id) = true
        )
    );

-- Function to get agent knowledge base entries
CREATE OR REPLACE FUNCTION get_agent_knowledge_base(
    p_agent_id UUID,
    p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    entry_id UUID,
    name VARCHAR(255),
    description TEXT,
    content TEXT,
    usage_context VARCHAR(100),
    is_active BOOLEAN,
    content_tokens INTEGER,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        akbe.entry_id,
        akbe.name,
        akbe.description,
        akbe.content,
        akbe.usage_context,
        akbe.is_active,
        akbe.content_tokens,
        akbe.created_at,
        akbe.updated_at
    FROM agent_knowledge_base_entries akbe
    WHERE akbe.agent_id = p_agent_id
    AND (p_include_inactive OR akbe.is_active = TRUE)
    ORDER BY akbe.created_at DESC;
END;
$$;

-- Function to get agent knowledge base context for prompts
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
    current_tokens INTEGER := 0;
    estimated_tokens INTEGER;
    agent_name TEXT;
BEGIN
    -- Get agent name for context header
    SELECT name INTO agent_name FROM agents WHERE agent_id = p_agent_id;
    
    FOR entry_record IN
        SELECT 
            entry_id,
            name,
            description,
            content,
            content_tokens
        FROM agent_knowledge_base_entries
        WHERE agent_id = p_agent_id
        AND is_active = TRUE
        AND usage_context IN ('always', 'contextual')
        ORDER BY created_at DESC
    LOOP
        estimated_tokens := COALESCE(entry_record.content_tokens, LENGTH(entry_record.content) / 4);
        
        IF current_tokens + estimated_tokens > p_max_tokens THEN
            EXIT;
        END IF;
        
        context_text := context_text || E'\n\n## ' || entry_record.name || E'\n';
        
        IF entry_record.description IS NOT NULL AND entry_record.description != '' THEN
            context_text := context_text || entry_record.description || E'\n\n';
        END IF;
        
        context_text := context_text || entry_record.content;
        
        current_tokens := current_tokens + estimated_tokens;
        
        -- Log usage for agent knowledge base
        INSERT INTO agent_knowledge_base_usage_log (entry_id, agent_id, usage_type, tokens_used)
        VALUES (entry_record.entry_id, p_agent_id, 'context_injection', estimated_tokens);
    END LOOP;
    
    RETURN CASE 
        WHEN context_text = '' THEN NULL
        ELSE E'# AGENT KNOWLEDGE BASE\n\nThe following is your specialized knowledge base. Use this information as context when responding:' || context_text
    END;
END;
$$;

-- Function to get combined knowledge base context (agent + thread)
CREATE OR REPLACE FUNCTION get_combined_knowledge_base_context(
    p_thread_id UUID,
    p_agent_id UUID DEFAULT NULL,
    p_max_tokens INTEGER DEFAULT 4000
)
RETURNS TEXT
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    context_text TEXT := '';
    agent_context TEXT := '';
    thread_context TEXT := '';
    total_tokens INTEGER := 0;
    agent_tokens INTEGER := 0;
    thread_tokens INTEGER := 0;
BEGIN
    -- Get agent-specific context if agent_id is provided
    IF p_agent_id IS NOT NULL THEN
        agent_context := get_agent_knowledge_base_context(p_agent_id, p_max_tokens / 2);
        IF agent_context IS NOT NULL THEN
            agent_tokens := LENGTH(agent_context) / 4;
            total_tokens := agent_tokens;
        END IF;
    END IF;
    
    -- Get thread-specific context with remaining tokens
    thread_context := get_knowledge_base_context(p_thread_id, p_max_tokens - total_tokens);
    IF thread_context IS NOT NULL THEN
        thread_tokens := LENGTH(thread_context) / 4;
        total_tokens := total_tokens + thread_tokens;
    END IF;
    
    -- Combine contexts
    IF agent_context IS NOT NULL AND thread_context IS NOT NULL THEN
        context_text := agent_context || E'\n\n' || thread_context;
    ELSIF agent_context IS NOT NULL THEN
        context_text := agent_context;
    ELSIF thread_context IS NOT NULL THEN
        context_text := thread_context;
    END IF;
    
    RETURN context_text;
END;
$$;

-- Create triggers for automatic token calculation and timestamp updates
CREATE OR REPLACE FUNCTION update_agent_kb_entry_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    IF NEW.content != OLD.content THEN
        NEW.content_tokens = LENGTH(NEW.content) / 4;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_kb_entries_updated_at
    BEFORE UPDATE ON agent_knowledge_base_entries
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_kb_entry_timestamp();

CREATE OR REPLACE FUNCTION calculate_agent_kb_entry_tokens()
RETURNS TRIGGER AS $$
BEGIN
    NEW.content_tokens = LENGTH(NEW.content) / 4;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_agent_kb_entries_calculate_tokens
    BEFORE INSERT ON agent_knowledge_base_entries
    FOR EACH ROW
    EXECUTE FUNCTION calculate_agent_kb_entry_tokens();

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE agent_knowledge_base_entries TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE agent_knowledge_base_usage_log TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION get_agent_knowledge_base TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_agent_knowledge_base_context TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_combined_knowledge_base_context TO authenticated, service_role;

-- Add comments
COMMENT ON TABLE agent_knowledge_base_entries IS 'Stores knowledge base entries specific to individual agents';
COMMENT ON TABLE agent_knowledge_base_usage_log IS 'Logs when and how agent knowledge base entries are used';

COMMENT ON FUNCTION get_agent_knowledge_base IS 'Retrieves all knowledge base entries for a specific agent';
COMMENT ON FUNCTION get_agent_knowledge_base_context IS 'Generates agent-specific knowledge base context text for prompts';
COMMENT ON FUNCTION get_combined_knowledge_base_context IS 'Generates combined agent and thread knowledge base context';

COMMIT; 