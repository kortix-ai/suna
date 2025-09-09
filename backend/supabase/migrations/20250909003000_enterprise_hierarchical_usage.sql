-- Enterprise Hierarchical Usage Data
-- Adds support for hierarchical usage display (Date → Project → Usage Details)
BEGIN;

-- Function to get hierarchical usage data for enterprise users
CREATE OR REPLACE FUNCTION public.get_enterprise_hierarchical_usage(
    p_account_id UUID,
    p_days INTEGER DEFAULT 30,
    p_page INTEGER DEFAULT 0,
    p_items_per_page INTEGER DEFAULT 1000
)
RETURNS TABLE(
    usage_date DATE,
    thread_id UUID,
    project_id UUID,
    project_title TEXT,
    thread_title TEXT,
    thread_cost DECIMAL,
    thread_tokens INTEGER,
    usage_details JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_since_date TIMESTAMPTZ;
BEGIN
    -- Calculate date range
    v_since_date := NOW() - INTERVAL '1 day' * p_days;
    
    RETURN QUERY
    WITH usage_with_thread_info AS (
        SELECT 
            eu.id,
            eu.account_id,
            eu.thread_id,
            eu.message_id,
            eu.cost,
            eu.model_name,
            eu.tokens_used,
            eu.tool_name,
            eu.tool_cost,
            eu.usage_type,
            eu.created_at,
            t.project_id,
            t.title as thread_title,
            p.title as project_title
        FROM enterprise_usage eu
        LEFT JOIN threads t ON eu.thread_id = t.thread_id
        LEFT JOIN projects p ON t.project_id = p.project_id
        WHERE eu.account_id = p_account_id
        AND eu.created_at >= v_since_date
        ORDER BY eu.created_at DESC
    ),
    messages_content AS (
        SELECT 
            uwti.*,
            m.content
        FROM usage_with_thread_info uwti
        LEFT JOIN messages m ON uwti.message_id = m.message_id
    ),
    thread_aggregates AS (
        SELECT 
            DATE(mc.created_at) as usage_date,
            mc.thread_id,
            mc.project_id,
            COALESCE(mc.project_title, 'Untitled Project') as project_title,
            COALESCE(mc.thread_title, 'Untitled Chat') as thread_title,
            SUM(mc.cost) as thread_cost,
            SUM(COALESCE(mc.tokens_used, 0)) as thread_tokens,
            JSONB_AGG(
                JSONB_BUILD_OBJECT(
                    'id', mc.id,
                    'message_id', mc.message_id,
                    'created_at', mc.created_at,
                    'cost', mc.cost,
                    'model_name', mc.model_name,
                    'tokens_used', mc.tokens_used,
                    'tool_name', mc.tool_name,
                    'tool_cost', mc.tool_cost,
                    'usage_type', mc.usage_type,
                    'content', mc.content
                ) ORDER BY mc.created_at DESC
            ) as usage_details
        FROM messages_content mc
        WHERE mc.thread_id IS NOT NULL
        GROUP BY DATE(mc.created_at), mc.thread_id, mc.project_id, mc.project_title, mc.thread_title
    )
    SELECT 
        ta.usage_date,
        ta.thread_id,
        ta.project_id,
        ta.project_title,
        ta.thread_title,
        ta.thread_cost,
        ta.thread_tokens,
        ta.usage_details
    FROM thread_aggregates ta
    ORDER BY ta.usage_date DESC, ta.thread_cost DESC
    LIMIT p_items_per_page OFFSET (p_page * p_items_per_page);
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION public.get_enterprise_hierarchical_usage TO authenticated;

COMMIT;
