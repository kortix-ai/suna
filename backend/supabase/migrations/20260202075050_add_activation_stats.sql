-- Migration: Add RPC function for signup activation stats
-- Returns activation rate and task distribution for free tier signups

BEGIN;

CREATE OR REPLACE FUNCTION get_signup_activation_stats(
    date_from timestamptz,
    date_to timestamptz
)
RETURNS TABLE (
    total_signups integer,
    activated_signups integer,
    bucket_0 integer,
    bucket_1 integer,
    bucket_2_5 integer,
    bucket_6_10 integer,
    bucket_10_plus integer
) AS $$
BEGIN
    RETURN QUERY
    WITH signups_in_range AS (
        SELECT a.id
        FROM basejump.accounts a
        JOIN credit_accounts ca ON ca.account_id = a.id
        WHERE a.created_at >= date_from
          AND a.created_at <= date_to
          AND ca.tier = 'free'
    ),
    task_counts AS (
        SELECT
            s.id,
            COUNT(ar.id)::integer as task_count
        FROM signups_in_range s
        LEFT JOIN threads t ON t.account_id = s.id
        LEFT JOIN agent_runs ar ON ar.thread_id = t.thread_id
        GROUP BY s.id
    )
    SELECT
        (SELECT COUNT(*)::integer FROM signups_in_range),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count > 0),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count = 0),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count = 1),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count BETWEEN 2 AND 5),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count BETWEEN 6 AND 10),
        (SELECT COUNT(*)::integer FROM task_counts WHERE task_count > 10);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to service_role (admin API uses service role)
GRANT EXECUTE ON FUNCTION get_signup_activation_stats(timestamptz, timestamptz) TO service_role;

COMMIT;
