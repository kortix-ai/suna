CREATE INDEX IF NOT EXISTS idx_messages_llm_thread_created 
ON public.messages(thread_id, created_at ASC)
WHERE is_llm_message = true;

DROP FUNCTION IF EXISTS get_llm_messages_for_thread(UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_llm_messages_for_thread(
    p_thread_id UUID,
    p_limit INTEGER DEFAULT 1000,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    message_id UUID,
    type TEXT,
    content JSONB,
    metadata JSONB
)
LANGUAGE sql
STABLE
AS $$
    SELECT 
        m.message_id,
        m.type,
        m.content,
        m.metadata
    FROM messages m
    WHERE m.thread_id = p_thread_id 
      AND m.is_llm_message = true
      AND (m.metadata->>'omitted' IS NULL OR m.metadata->>'omitted' != 'true')
    ORDER BY m.created_at ASC
    LIMIT p_limit 
    OFFSET p_offset;
$$;
