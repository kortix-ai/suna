-- RPC function to get retention/recurring user data (aggregation in SQL, not Python)
-- Returns users who were active in multiple weeks over a given period

CREATE OR REPLACE FUNCTION get_retention_data(
    p_weeks_back INT DEFAULT 4,
    p_min_weeks_active INT DEFAULT 2,
    p_page INT DEFAULT 1,
    p_page_size INT DEFAULT 20
)
RETURNS TABLE (
    user_id UUID,
    email TEXT,
    weeks_active BIGINT,
    total_threads BIGINT,
    first_activity TIMESTAMPTZ,
    last_activity TIMESTAMPTZ,
    total_count BIGINT
) AS $$
DECLARE
    v_start_date TIMESTAMPTZ;
BEGIN
    -- Calculate start date
    v_start_date := NOW() - (p_weeks_back || ' weeks')::INTERVAL;

    RETURN QUERY
    WITH thread_weeks AS (
        -- Get all threads in the period and calculate which week they belong to
        SELECT
            t.account_id,
            DATE_TRUNC('week', t.created_at) AS week_start,
            t.created_at,
            t.updated_at
        FROM threads t
        WHERE t.created_at >= v_start_date
          AND t.account_id IS NOT NULL
    ),
    user_summary AS (
        -- Aggregate by user
        SELECT
            tw.account_id,
            COUNT(DISTINCT tw.week_start) AS weeks_active,
            COUNT(*) AS total_threads,
            MIN(tw.created_at) AS first_activity,
            MAX(tw.updated_at) AS last_activity
        FROM thread_weeks tw
        GROUP BY tw.account_id
        HAVING COUNT(DISTINCT tw.week_start) >= p_min_weeks_active
    ),
    counted AS (
        -- Get total count for pagination
        SELECT COUNT(*) AS cnt FROM user_summary
    )
    SELECT
        us.account_id AS user_id,
        bc.email::TEXT,
        us.weeks_active,
        us.total_threads,
        us.first_activity,
        us.last_activity,
        c.cnt AS total_count
    FROM user_summary us
    CROSS JOIN counted c
    LEFT JOIN basejump.billing_customers bc ON bc.account_id = us.account_id
    ORDER BY us.weeks_active DESC, us.total_threads DESC
    LIMIT p_page_size
    OFFSET (p_page - 1) * p_page_size;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
