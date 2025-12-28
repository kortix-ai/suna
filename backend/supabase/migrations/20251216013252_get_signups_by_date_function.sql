-- Migration: Add function to get signup counts grouped by date
-- Bypasses PostgREST row limits by doing aggregation in database

CREATE OR REPLACE FUNCTION get_signups_by_date(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(signup_date DATE, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        DATE(a.created_at) as signup_date,
        COUNT(*)::BIGINT as count
    FROM basejump.accounts a
    WHERE a.created_at >= start_date
      AND a.created_at <= end_date
    GROUP BY DATE(a.created_at)
    ORDER BY signup_date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_signups_by_date(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role, authenticated;
