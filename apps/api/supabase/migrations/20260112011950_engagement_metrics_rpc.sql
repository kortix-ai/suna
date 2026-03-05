-- RPC function to get engagement metrics efficiently using COUNT(DISTINCT)
-- This replaces fetching all rows and counting in Python
CREATE OR REPLACE FUNCTION get_engagement_metrics(
    p_today_start TIMESTAMPTZ,
    p_today_end TIMESTAMPTZ,
    p_week_start TIMESTAMPTZ,
    p_month_start TIMESTAMPTZ
)
RETURNS TABLE (
    dau BIGINT,
    wau BIGINT,
    mau BIGINT,
    threads_today BIGINT,
    threads_week BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        (SELECT COUNT(DISTINCT account_id) FROM threads 
         WHERE created_at >= p_today_start AND created_at < p_today_end) as dau,
        (SELECT COUNT(DISTINCT account_id) FROM threads 
         WHERE created_at >= p_week_start AND created_at < p_today_end) as wau,
        (SELECT COUNT(DISTINCT account_id) FROM threads 
         WHERE created_at >= p_month_start AND created_at < p_today_end) as mau,
        (SELECT COUNT(*) FROM threads 
         WHERE created_at >= p_today_start AND created_at < p_today_end) as threads_today,
        (SELECT COUNT(*) FROM threads 
         WHERE created_at >= p_week_start AND created_at < p_today_end) as threads_week;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
