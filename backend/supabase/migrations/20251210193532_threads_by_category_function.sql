-- Migration: Add efficient function to get threads by category and project date
-- This function does the JOIN inside the database with proper pagination

-- Function to get threads with pagination
CREATE OR REPLACE FUNCTION get_threads_by_category(
    p_category TEXT,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_min_messages INT DEFAULT NULL,
    p_max_messages INT DEFAULT NULL,
    p_sort_by TEXT DEFAULT 'created_at',
    p_sort_order TEXT DEFAULT 'desc',
    p_limit INT DEFAULT 15,
    p_offset INT DEFAULT 0
)
RETURNS TABLE(
    thread_id UUID,
    project_id UUID,
    account_id UUID,
    is_public BOOLEAN,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    user_message_count INT,
    total_message_count INT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        t.thread_id,
        t.project_id,
        t.account_id,
        t.is_public,
        t.created_at,
        t.updated_at,
        t.user_message_count,
        t.total_message_count
    FROM threads t
    INNER JOIN projects p ON t.project_id = p.project_id
    WHERE 
        -- Handle category filter (NULL for 'Uncategorized')
        CASE 
            WHEN p_category = 'Uncategorized' THEN p.category IS NULL
            ELSE p.category = p_category
        END
        -- Filter by project creation date if provided
        AND (p_date_from IS NULL OR p.created_at >= p_date_from)
        AND (p_date_to IS NULL OR p.created_at <= p_date_to)
        -- Filter by message count if provided
        AND (p_min_messages IS NULL OR COALESCE(t.user_message_count, 0) >= p_min_messages)
        AND (p_max_messages IS NULL OR COALESCE(t.user_message_count, 0) <= p_max_messages)
    ORDER BY
        CASE WHEN p_sort_by = 'created_at' AND p_sort_order = 'desc' THEN t.created_at END DESC,
        CASE WHEN p_sort_by = 'created_at' AND p_sort_order = 'asc' THEN t.created_at END ASC,
        CASE WHEN p_sort_by = 'updated_at' AND p_sort_order = 'desc' THEN t.updated_at END DESC,
        CASE WHEN p_sort_by = 'updated_at' AND p_sort_order = 'asc' THEN t.updated_at END ASC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get total count for pagination
CREATE OR REPLACE FUNCTION get_threads_by_category_count(
    p_category TEXT,
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_min_messages INT DEFAULT NULL,
    p_max_messages INT DEFAULT NULL
)
RETURNS BIGINT AS $$
DECLARE
    total_count BIGINT;
BEGIN
    SELECT COUNT(*)
    INTO total_count
    FROM threads t
    INNER JOIN projects p ON t.project_id = p.project_id
    WHERE 
        CASE 
            WHEN p_category = 'Uncategorized' THEN p.category IS NULL
            ELSE p.category = p_category
        END
        AND (p_date_from IS NULL OR p.created_at >= p_date_from)
        AND (p_date_to IS NULL OR p.created_at <= p_date_to)
        AND (p_min_messages IS NULL OR COALESCE(t.user_message_count, 0) >= p_min_messages)
        AND (p_max_messages IS NULL OR COALESCE(t.user_message_count, 0) <= p_max_messages);
    
    RETURN total_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_threads_by_category(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, TEXT, TEXT, INT, INT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_threads_by_category_count(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO service_role, authenticated;

-- Add composite index for category + created_at filtering (individual indexes already exist)
CREATE INDEX IF NOT EXISTS idx_projects_category_created_at ON projects(category, created_at);
