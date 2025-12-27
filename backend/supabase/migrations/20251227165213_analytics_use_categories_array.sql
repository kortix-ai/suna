-- Migration: Update analytics functions to use categories array
-- This supports multi-category projects where one project can have multiple categories

-- 1. Add GIN index for efficient array lookups
CREATE INDEX IF NOT EXISTS idx_projects_categories_gin ON projects USING GIN (categories);

-- 2. Update category distribution to use categories array (unnest for multi-category support)
CREATE OR REPLACE FUNCTION get_project_category_distribution(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(category TEXT, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(cat, 'Uncategorized')::TEXT as category,
        COUNT(*)::BIGINT as count
    FROM projects p
    LEFT JOIN LATERAL unnest(CASE WHEN p.categories = '{}' OR p.categories IS NULL THEN ARRAY[NULL::TEXT] ELSE p.categories END) AS cat ON true
    WHERE p.created_at >= start_date
      AND p.created_at <= end_date
    GROUP BY cat
    ORDER BY count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Update threads by category to use categories array
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
        -- Handle category filter using categories array
        CASE 
            WHEN p_category = 'Uncategorized' THEN (p.categories IS NULL OR p.categories = '{}')
            ELSE p_category = ANY(p.categories)
        END
        AND (p_date_from IS NULL OR p.created_at >= p_date_from)
        AND (p_date_to IS NULL OR p.created_at <= p_date_to)
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

-- 4. Update threads by category count to use categories array
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
            WHEN p_category = 'Uncategorized' THEN (p.categories IS NULL OR p.categories = '{}')
            ELSE p_category = ANY(p.categories)
        END
        AND (p_date_from IS NULL OR p.created_at >= p_date_from)
        AND (p_date_to IS NULL OR p.created_at <= p_date_to)
        AND (p_min_messages IS NULL OR COALESCE(t.user_message_count, 0) >= p_min_messages)
        AND (p_max_messages IS NULL OR COALESCE(t.user_message_count, 0) <= p_max_messages);
    
    RETURN total_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

