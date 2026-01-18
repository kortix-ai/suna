ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_omitted BOOLEAN DEFAULT FALSE;

UPDATE messages 
SET is_omitted = TRUE 
WHERE metadata->>'omitted' = 'true' 
  AND is_omitted = FALSE;

CREATE OR REPLACE FUNCTION sync_is_omitted_from_metadata()
RETURNS TRIGGER AS $$
BEGIN
    NEW.is_omitted := COALESCE(NEW.metadata->>'omitted' = 'true', FALSE);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_is_omitted_insert ON messages;
CREATE TRIGGER trg_sync_is_omitted_insert
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION sync_is_omitted_from_metadata();

DROP TRIGGER IF EXISTS trg_sync_is_omitted_update ON messages;
CREATE TRIGGER trg_sync_is_omitted_update
    BEFORE UPDATE ON messages
    FOR EACH ROW
    WHEN (OLD.metadata IS DISTINCT FROM NEW.metadata)
    EXECUTE FUNCTION sync_is_omitted_from_metadata();

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
      AND m.is_omitted = false
    ORDER BY m.created_at ASC
    LIMIT p_limit 
    OFFSET p_offset;
$$;

ANALYZE messages;
