-- Migration: Add efficient GROUP BY functions for analytics distribution queries
-- These functions bypass PostgREST row limits and perform aggregation in the database

-- 1. Function to get project category distribution for a date range
CREATE OR REPLACE FUNCTION get_project_category_distribution(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(category TEXT, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(p.category, 'Uncategorized')::TEXT as category,
        COUNT(*)::BIGINT as count
    FROM projects p
    WHERE p.created_at >= start_date
      AND p.created_at <= end_date
    GROUP BY p.category
    ORDER BY count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Function to get thread message distribution for a date range
-- Categorizes threads by user_message_count into buckets
CREATE OR REPLACE FUNCTION get_thread_message_distribution(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(
    zero_messages BIGINT,
    one_message BIGINT,
    two_three_messages BIGINT,
    five_plus_messages BIGINT,
    total_threads BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) FILTER (WHERE COALESCE(t.user_message_count, 0) = 0)::BIGINT as zero_messages,
        COUNT(*) FILTER (WHERE COALESCE(t.user_message_count, 0) = 1)::BIGINT as one_message,
        COUNT(*) FILTER (WHERE COALESCE(t.user_message_count, 0) BETWEEN 2 AND 3)::BIGINT as two_three_messages,
        COUNT(*) FILTER (WHERE COALESCE(t.user_message_count, 0) >= 5)::BIGINT as five_plus_messages,
        COUNT(*)::BIGINT as total_threads
    FROM threads t
    WHERE t.created_at >= start_date
      AND t.created_at <= end_date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_project_category_distribution(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION get_thread_message_distribution(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;
