-- Migration: Add tier distribution analytics functions
-- Enables filtering threads by subscription tier in admin analytics

-- 1. Function to get thread tier distribution for a date range
-- Groups threads by the account's subscription tier
CREATE OR REPLACE FUNCTION get_thread_tier_distribution(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(tier TEXT, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(ca.tier, 'none')::TEXT as tier,
        COUNT(*)::BIGINT as count
    FROM threads t
    INNER JOIN credit_accounts ca ON t.account_id = ca.account_id
    WHERE t.created_at >= start_date
      AND t.created_at <= end_date
    GROUP BY ca.tier
    ORDER BY count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Function to get threads by tier with pagination
CREATE OR REPLACE FUNCTION get_threads_by_tier(
    p_tier TEXT,
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
    INNER JOIN credit_accounts ca ON t.account_id = ca.account_id
    WHERE 
        -- Handle tier filter (treat 'none' as NULL tier)
        CASE 
            WHEN p_tier = 'none' THEN (ca.tier IS NULL OR ca.tier = 'none')
            ELSE ca.tier = p_tier
        END
        AND (p_date_from IS NULL OR t.created_at >= p_date_from)
        AND (p_date_to IS NULL OR t.created_at <= p_date_to)
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

-- 3. Function to get count of threads by tier (for pagination)
CREATE OR REPLACE FUNCTION get_threads_by_tier_count(
    p_tier TEXT,
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
    INNER JOIN credit_accounts ca ON t.account_id = ca.account_id
    WHERE 
        CASE 
            WHEN p_tier = 'none' THEN (ca.tier IS NULL OR ca.tier = 'none')
            ELSE ca.tier = p_tier
        END
        AND (p_date_from IS NULL OR t.created_at >= p_date_from)
        AND (p_date_to IS NULL OR t.created_at <= p_date_to)
        AND (p_min_messages IS NULL OR COALESCE(t.user_message_count, 0) >= p_min_messages)
        AND (p_max_messages IS NULL OR COALESCE(t.user_message_count, 0) <= p_max_messages);
    
    RETURN total_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_thread_tier_distribution(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_threads_by_tier(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, TEXT, TEXT, INT, INT) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_threads_by_tier_count(TEXT, TIMESTAMPTZ, TIMESTAMPTZ, INT, INT) TO service_role, authenticated;

