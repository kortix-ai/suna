-- Cohort retention matrix for admin analytics.
-- Each cohort is users whose first non-trigger thread was created in that week.

CREATE OR REPLACE FUNCTION get_retention_cohorts(
    p_cohorts_back INT DEFAULT 8,
    p_weeks_to_measure INT DEFAULT 4
)
RETURNS TABLE (
    cohort_week_start DATE,
    cohort_week_end DATE,
    cohort_size BIGINT,
    week_1_pct INT,
    week_2_pct INT,
    week_3_pct INT,
    week_4_pct INT,
    week_5_pct INT,
    week_6_pct INT,
    week_7_pct INT,
    week_8_pct INT,
    week_9_pct INT,
    week_10_pct INT,
    week_11_pct INT,
    week_12_pct INT
) AS $$
DECLARE
    v_current_week DATE;
    v_oldest_cohort DATE;
BEGIN
    p_cohorts_back := GREATEST(1, LEAST(p_cohorts_back, 24));
    p_weeks_to_measure := GREATEST(1, LEAST(p_weeks_to_measure, 12));

    v_current_week := DATE_TRUNC('week', NOW())::DATE;
    v_oldest_cohort := (v_current_week - ((p_cohorts_back - 1) * INTERVAL '1 week'))::DATE;

    RETURN QUERY
    WITH user_activity_weeks AS (
        SELECT
            t.account_id,
            DATE_TRUNC('week', t.created_at)::DATE AS activity_week
        FROM threads t
        WHERE t.account_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM agent_runs ar
              WHERE ar.thread_id = t.thread_id
                AND (
                    COALESCE(ar.metadata->>'trigger_execution', 'false') = 'true'
                    OR COALESCE(ar.metadata, '{}'::jsonb) ? 'trigger_id'
                )
          )
        GROUP BY t.account_id, DATE_TRUNC('week', t.created_at)::DATE
    ),
    first_activity AS (
        SELECT
            uaw.account_id,
            MIN(uaw.activity_week) AS cohort_week_start
        FROM user_activity_weeks uaw
        GROUP BY uaw.account_id
    ),
    cohort_members AS (
        SELECT
            fa.account_id,
            fa.cohort_week_start
        FROM first_activity fa
        WHERE fa.cohort_week_start BETWEEN v_oldest_cohort AND v_current_week
    ),
    cohort_sizes AS (
        SELECT
            cm.cohort_week_start,
            COUNT(*) AS cohort_size
        FROM cohort_members cm
        GROUP BY cm.cohort_week_start
    ),
    cohort_week_activity AS (
        SELECT
            cm.cohort_week_start,
            cm.account_id,
            ((uaw.activity_week - cm.cohort_week_start) / 7)::INT AS week_offset
        FROM cohort_members cm
        JOIN user_activity_weeks uaw ON uaw.account_id = cm.account_id
        WHERE ((uaw.activity_week - cm.cohort_week_start) / 7)::INT BETWEEN 0 AND (p_weeks_to_measure - 1)
    ),
    weekly_pivot AS (
        SELECT
            cwa.cohort_week_start,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 0) AS week_0_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 1) AS week_1_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 2) AS week_2_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 3) AS week_3_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 4) AS week_4_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 5) AS week_5_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 6) AS week_6_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 7) AS week_7_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 8) AS week_8_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 9) AS week_9_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 10) AS week_10_retained,
            COUNT(DISTINCT cwa.account_id) FILTER (WHERE cwa.week_offset = 11) AS week_11_retained
        FROM cohort_week_activity cwa
        GROUP BY cwa.cohort_week_start
    )
    SELECT
        cs.cohort_week_start,
        (cs.cohort_week_start + INTERVAL '6 days')::DATE AS cohort_week_end,
        cs.cohort_size,
        CASE
            WHEN 1 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (0 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_0_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_1_pct,
        CASE
            WHEN 2 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (1 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_1_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_2_pct,
        CASE
            WHEN 3 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (2 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_2_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_3_pct,
        CASE
            WHEN 4 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (3 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_3_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_4_pct,
        CASE
            WHEN 5 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (4 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_4_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_5_pct,
        CASE
            WHEN 6 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (5 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_5_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_6_pct,
        CASE
            WHEN 7 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (6 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_6_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_7_pct,
        CASE
            WHEN 8 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (7 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_7_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_8_pct,
        CASE
            WHEN 9 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (8 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_8_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_9_pct,
        CASE
            WHEN 10 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (9 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_9_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_10_pct,
        CASE
            WHEN 11 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (10 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_10_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_11_pct,
        CASE
            WHEN 12 > p_weeks_to_measure THEN NULL
            WHEN (cs.cohort_week_start + (11 * INTERVAL '1 week'))::DATE > v_current_week THEN NULL
            ELSE ROUND((COALESCE(wp.week_11_retained, 0)::NUMERIC / NULLIF(cs.cohort_size, 0)) * 100)::INT
        END AS week_12_pct
    FROM cohort_sizes cs
    LEFT JOIN weekly_pivot wp ON wp.cohort_week_start = cs.cohort_week_start
    ORDER BY cs.cohort_week_start;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION get_retention_cohorts(INT, INT) TO service_role;
