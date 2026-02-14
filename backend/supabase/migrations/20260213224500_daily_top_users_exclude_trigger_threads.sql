-- RPC function for identifying top daily active users in an explicit date range.
-- "Active day" means at least one user-driven thread launched on that calendar day.
-- Trigger-originated threads are excluded.

CREATE OR REPLACE FUNCTION get_daily_top_users(
    p_date_from TIMESTAMPTZ,
    p_date_to TIMESTAMPTZ,
    p_page INT DEFAULT 1,
    p_page_size INT DEFAULT 20,
    p_timezone TEXT DEFAULT 'UTC'
)
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    active_days BIGINT,
    threads_in_range BIGINT,
    agent_runs_in_range BIGINT,
    first_activity TIMESTAMPTZ,
    last_activity TIMESTAMPTZ,
    total_count BIGINT
) AS $$
DECLARE
    v_start_date TIMESTAMPTZ;
    v_end_date TIMESTAMPTZ;
BEGIN
    v_start_date := p_date_from;
    v_end_date := p_date_to;

    RETURN QUERY
    WITH daily_threads AS (
        SELECT
            t.thread_id,
            t.account_id,
            (t.created_at AT TIME ZONE p_timezone)::DATE AS activity_day,
            t.created_at,
            t.updated_at
        FROM threads t
        WHERE t.created_at >= v_start_date
          AND t.created_at <= v_end_date
          AND t.account_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM agent_runs ar
              WHERE ar.thread_id = t.thread_id
                AND (
                    COALESCE(ar.metadata->>'trigger_execution', 'false') = 'true'
                    OR COALESCE(ar.metadata, '{}'::jsonb) ? 'trigger_id'
                )
          )
    ),
    user_summary AS (
        SELECT
            dt.account_id,
            COUNT(DISTINCT dt.activity_day) AS active_days,
            COUNT(*) AS total_threads,
            MIN(dt.created_at) AS first_activity,
            MAX(dt.updated_at) AS last_activity
        FROM daily_threads dt
        GROUP BY dt.account_id
    ),
    runs_by_user AS (
        SELECT
            t.account_id,
            COUNT(ar.id) AS agent_runs_in_range
        FROM agent_runs ar
        JOIN threads t ON t.thread_id = ar.thread_id
        WHERE ar.created_at >= v_start_date
          AND ar.created_at <= v_end_date
          AND t.account_id IS NOT NULL
          AND NOT (
              COALESCE(ar.metadata->>'trigger_execution', 'false') = 'true'
              OR COALESCE(ar.metadata, '{}'::jsonb) ? 'trigger_id'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM agent_runs ar2
              WHERE ar2.thread_id = t.thread_id
                AND (
                    COALESCE(ar2.metadata->>'trigger_execution', 'false') = 'true'
                    OR COALESCE(ar2.metadata, '{}'::jsonb) ? 'trigger_id'
                )
          )
        GROUP BY t.account_id
    ),
    counted AS (
        SELECT COUNT(*) AS cnt FROM user_summary
    )
    SELECT
        us.account_id AS user_id,
        bc.email::TEXT,
        us.active_days,
        us.total_threads AS threads_in_range,
        COALESCE(rbu.agent_runs_in_range, 0) AS agent_runs_in_range,
        us.first_activity,
        us.last_activity,
        c.cnt AS total_count
    FROM user_summary us
    CROSS JOIN counted c
    LEFT JOIN basejump.billing_customers bc ON bc.account_id = us.account_id
    LEFT JOIN runs_by_user rbu ON rbu.account_id = us.account_id
    ORDER BY us.total_threads DESC, COALESCE(rbu.agent_runs_in_range, 0) DESC, us.active_days DESC
    LIMIT p_page_size
    OFFSET (p_page - 1) * p_page_size;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_daily_top_users(TIMESTAMPTZ, TIMESTAMPTZ, INT, INT, TEXT) TO service_role;
