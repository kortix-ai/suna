-- Migration: Add combined tier + category filter support for threads
-- Allows filtering threads by both tier AND category simultaneously

-- Function to get threads filtered by both tier and category
CREATE OR REPLACE FUNCTION get_threads_by_tier_and_category(
    p_tier TEXT DEFAULT NULL,
    p_category TEXT DEFAULT NULL,
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
    -- Join with credit_accounts for tier filter
    LEFT JOIN credit_accounts ca ON t.account_id = ca.account_id
    -- Join with projects for category filter
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE 
        -- Tier filter (if provided)
        (p_tier IS NULL OR (
            CASE 
                WHEN p_tier = 'none' THEN (ca.tier IS NULL OR ca.tier = 'none')
                ELSE ca.tier = p_tier
            END
        ))
        -- Category filter (if provided)
        AND (p_category IS NULL OR (
            CASE 
                WHEN p_category = 'Uncategorized' THEN (p.categories IS NULL OR p.categories = '{}')
                ELSE p_category = ANY(p.categories)
            END
        ))
        -- Date filters
        AND (p_date_from IS NULL OR t.created_at >= p_date_from)
        AND (p_date_to IS NULL OR t.created_at <= p_date_to)
        -- Message count filters
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

-- Function to get count for combined tier + category filter (for pagination)
CREATE OR REPLACE FUNCTION get_threads_by_tier_and_category_count(
    p_tier TEXT DEFAULT NULL,
    p_category TEXT DEFAULT NULL,
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
    LEFT JOIN credit_accounts ca ON t.account_id = ca.account_id
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE 
        (p_tier IS NULL OR (
            CASE 
                WHEN p_tier = 'none' THEN (ca.tier IS NULL OR ca.tier = 'none')
                ELSE ca.tier = p_tier
            END
        ))
        AND (p_category IS NULL OR (
            CASE 
                WHEN p_category = 'Uncategorized' THEN (p.categories IS NULL OR p.categories = '{}')
                ELSE p_category = ANY(p.categories)
            END
        ))
        AND (p_date_from IS NULL OR t.created_at >= p_date_from)
        AND (p_date_to IS NULL OR t.created_at <= p_date_to)
        AND (p_min_messages IS NULL OR COALESCE(t.user_message_count, 0) >= p_min_messages)
        AND (p_max_messages IS NULL OR COALESCE(t.user_message_count, 0) <= p_max_messages);
    
    RETURN total_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_threads_by_tier_and_category(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, TEXT, TEXT, INT, INT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_threads_by_tier_and_category_count(TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO service_role, authenticated;

