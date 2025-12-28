-- Fix: Use messages.created_at instead of threads.updated_at
-- threads.updated_at can be bumped by migrations, causing false positives
-- messages.created_at only changes when user actually sends a message

CREATE OR REPLACE FUNCTION get_stale_projects_for_categorization(
    stale_threshold TIMESTAMP WITH TIME ZONE,
    max_count INT DEFAULT 50
)
RETURNS TABLE (project_id UUID) 
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT p.project_id
    FROM projects p
    INNER JOIN threads t ON t.project_id = p.project_id
    INNER JOIN (
        SELECT m.thread_id, MAX(m.created_at) as last_message_at
        FROM messages m
        WHERE m.type = 'user'
        GROUP BY m.thread_id
    ) msg_activity ON msg_activity.thread_id = t.thread_id
    WHERE msg_activity.last_message_at < stale_threshold
      AND (p.last_categorized_at IS NULL OR p.last_categorized_at < msg_activity.last_message_at)
    ORDER BY msg_activity.last_message_at DESC
    LIMIT max_count;
$$;

-- Note: Index creation skipped from migration to avoid long-running operation
-- Create the index manually later using CONCURRENTLY (non-blocking):
-- CREATE INDEX CONCURRENTLY idx_messages_thread_type_created 
-- ON messages (thread_id, type, created_at DESC);
-- 
-- This index is recommended for performance but the function will work without it (just slower)


