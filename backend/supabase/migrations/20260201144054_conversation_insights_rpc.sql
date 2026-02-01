-- RPC function for conversation insights aggregation
-- Replaces in-memory aggregation that hit Supabase's 1000 row limit

CREATE OR REPLACE FUNCTION get_conversation_insights(
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'total_analyzed', COUNT(*),
        'avg_frustration', COALESCE(ROUND(AVG(frustration_score)::numeric, 3), 0),
        'feature_request_count', COUNT(*) FILTER (WHERE is_feature_request = true),
        'sentiment_distribution', json_build_object(
            'positive', COUNT(*) FILTER (WHERE sentiment_label = 'positive'),
            'neutral', COUNT(*) FILTER (WHERE sentiment_label = 'neutral'),
            'negative', COUNT(*) FILTER (WHERE sentiment_label = 'negative'),
            'mixed', COUNT(*) FILTER (WHERE sentiment_label = 'mixed')
        ),
        'intent_distribution', json_build_object(
            'task', COUNT(*) FILTER (WHERE intent_type = 'task'),
            'question', COUNT(*) FILTER (WHERE intent_type = 'question'),
            'complaint', COUNT(*) FILTER (WHERE intent_type = 'complaint'),
            'feature_request', COUNT(*) FILTER (WHERE intent_type = 'feature_request')
        )
    ) INTO result
    FROM conversation_analytics
    WHERE (p_date_from IS NULL OR analyzed_at >= p_date_from)
      AND (p_date_to IS NULL OR analyzed_at < (p_date_to::date + INTERVAL '1 day'));

    RETURN result;
END;
$$;

-- Only service_role needs access (called from backend API, not frontend)
GRANT EXECUTE ON FUNCTION get_conversation_insights TO service_role;


-- RPC function for use case patterns aggregation
-- Replaces in-memory aggregation that hit Supabase's 1000 row limit

CREATE OR REPLACE FUNCTION get_use_case_patterns(
    p_date_from TIMESTAMPTZ DEFAULT NULL,
    p_date_to TIMESTAMPTZ DEFAULT NULL,
    p_limit INT DEFAULT 20
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    result JSON;
BEGIN
    WITH filtered AS (
        SELECT use_case_category, primary_topic
        FROM conversation_analytics
        WHERE (p_date_from IS NULL OR analyzed_at >= p_date_from)
          AND (p_date_to IS NULL OR analyzed_at < (p_date_to::date + INTERVAL '1 day'))
    ),
    use_case_agg AS (
        SELECT use_case_category, COUNT(*) as count
        FROM filtered
        WHERE use_case_category IS NOT NULL
        GROUP BY use_case_category
        ORDER BY count DESC
        LIMIT p_limit
    ),
    topic_agg AS (
        SELECT primary_topic, COUNT(*) as count
        FROM filtered
        WHERE primary_topic IS NOT NULL
        GROUP BY primary_topic
        ORDER BY count DESC
        LIMIT p_limit
    ),
    total_count AS (
        SELECT COUNT(*) as total FROM filtered
    )
    SELECT json_build_object(
        'top_use_cases', COALESCE((SELECT json_agg(json_build_object('use_case', use_case_category, 'count', count)) FROM use_case_agg), '[]'::json),
        'top_topics', COALESCE((SELECT json_agg(json_build_object('topic', primary_topic, 'count', count)) FROM topic_agg), '[]'::json),
        'total', (SELECT total FROM total_count)
    ) INTO result;

    RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_use_case_patterns TO service_role;


-- ============================================================================
-- Fix: Add ON DELETE SET NULL to agent_run_id foreign key
-- This allows agent_runs to be deleted without blocking on conversation_analytics
-- ============================================================================

ALTER TABLE conversation_analytics
DROP CONSTRAINT IF EXISTS conversation_analytics_agent_run_id_fkey;

ALTER TABLE conversation_analytics
ADD CONSTRAINT conversation_analytics_agent_run_id_fkey
FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE SET NULL;
