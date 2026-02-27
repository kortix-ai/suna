BEGIN;

-- Remove the combined knowledge base context function since only agent-based knowledge base exists
DROP FUNCTION IF EXISTS get_combined_knowledge_base_context(UUID, UUID, INTEGER);

-- Remove the thread-based knowledge base context function as well - only keeping agent-based
DROP FUNCTION IF EXISTS get_knowledge_base_context(UUID, INTEGER);

-- Drop the existing agent knowledge base context function with token limiting
DROP FUNCTION IF EXISTS get_agent_knowledge_base_context(UUID, INTEGER);

-- Simplify the agent knowledge base context function by removing token limiting
CREATE OR REPLACE FUNCTION get_agent_knowledge_base_context(
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
            entry_id,
            name,
            description,
            content
        FROM agent_knowledge_base_entries
        WHERE agent_id = p_agent_id
        AND is_active = TRUE
        AND usage_context IN ('always', 'contextual')
        ORDER BY created_at DESC
    LOOP
        context_text := context_text || E'\n\n## ' || entry_record.name || E'\n';
        
        IF entry_record.description IS NOT NULL AND entry_record.description != '' THEN
            context_text := context_text || entry_record.description || E'\n\n';
        END IF;
        
        context_text := context_text || entry_record.content;
        
        -- Log usage for agent knowledge base (without token counting)
        INSERT INTO agent_knowledge_base_usage_log (entry_id, agent_id, usage_type)
        VALUES (entry_record.entry_id, p_agent_id, 'context_injection');
    END LOOP;
    
    RETURN CASE 
        WHEN context_text = '' THEN NULL
        ELSE E'# AGENT KNOWLEDGE BASE\n\nThe following is your specialized knowledge base. Use this information as context when responding:' || context_text
    END;
END;
$$;

-- Update comments to clarify that agent-based is the only knowledge base function
COMMENT ON FUNCTION get_agent_knowledge_base_context IS 'Generates agent-specific knowledge base context text for prompts - simplified without token limiting';

COMMIT;
