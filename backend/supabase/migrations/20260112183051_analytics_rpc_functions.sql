-- RPC function to get active users count for a week (COUNT DISTINCT in SQL, not Python)
CREATE OR REPLACE FUNCTION get_active_users_week(p_week_start TIMESTAMPTZ)
RETURNS TABLE (count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT COUNT(DISTINCT account_id)
    FROM threads
    WHERE updated_at >= p_week_start
      AND account_id IS NOT NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RPC function to get task performance metrics (aggregation in SQL, not Python)
CREATE OR REPLACE FUNCTION get_task_performance(
    p_start TIMESTAMPTZ,
    p_end TIMESTAMPTZ
)
RETURNS TABLE (
    total_runs BIGINT,
    completed_runs BIGINT,
    failed_runs BIGINT,
    stopped_runs BIGINT,
    running_runs BIGINT,
    pending_runs BIGINT,
    avg_duration_seconds NUMERIC,
    runs_by_status JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::BIGINT as total_runs,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::BIGINT as completed_runs,
        SUM(CASE WHEN status IN ('failed', 'error') THEN 1 ELSE 0 END)::BIGINT as failed_runs,
        SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END)::BIGINT as stopped_runs,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)::BIGINT as running_runs,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)::BIGINT as pending_runs,
        ROUND(AVG(
            CASE 
                WHEN status IN ('completed', 'failed', 'stopped') 
                     AND started_at IS NOT NULL 
                     AND completed_at IS NOT NULL 
                     AND EXTRACT(EPOCH FROM (completed_at - started_at)) > 0
                THEN EXTRACT(EPOCH FROM (completed_at - started_at))
                ELSE NULL
            END
        )::NUMERIC, 1) as avg_duration_seconds,
        COALESCE(
            (SELECT jsonb_object_agg(s.status, s.cnt)
             FROM (
                 SELECT ar.status, COUNT(*) as cnt
                 FROM agent_runs ar
                 WHERE ar.created_at >= p_start AND ar.created_at < p_end
                 GROUP BY ar.status
             ) s),
            '{}'::jsonb
        ) as runs_by_status
    FROM agent_runs
    WHERE created_at >= p_start AND created_at < p_end;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
