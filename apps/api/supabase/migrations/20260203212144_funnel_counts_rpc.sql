-- Fix: Return aggregated counts instead of rows to bypass PostgREST 1000 row limit

CREATE OR REPLACE FUNCTION get_free_signups_funnel_counts(
    date_from TIMESTAMPTZ,
    date_to TIMESTAMPTZ
)
RETURNS TABLE (
    total_signups BIGINT,
    tried_task BIGINT,
    viewed_pricing BIGINT,
    tried_and_viewed BIGINT,
    clicked_checkout BIGINT,
    converted BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH signups AS (
        SELECT
            a.primary_owner_user_id as uid,
            a.id as account_id
        FROM basejump.accounts a
        WHERE a.created_at >= date_from
          AND a.created_at <= date_to
          AND a.personal_account = true
    ),
    activity AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN threads t ON t.account_id = s.account_id
        JOIN agent_runs ar ON ar.thread_id = t.thread_id
    ),
    pricing AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN pricing_views pv ON pv.user_id = s.uid
    ),
    checkout AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN checkout_clicks cc ON cc.user_id = s.uid
    ),
    conversions AS (
        SELECT DISTINCT s.uid
        FROM signups s
        JOIN credit_accounts ca ON ca.account_id = s.account_id
        WHERE ca.tier NOT IN ('free', 'none')
    )
    SELECT
        (SELECT COUNT(*) FROM signups)::BIGINT as total_signups,
        (SELECT COUNT(*) FROM activity)::BIGINT as tried_task,
        (SELECT COUNT(*) FROM pricing)::BIGINT as viewed_pricing,
        (SELECT COUNT(*) FROM signups s WHERE EXISTS (SELECT 1 FROM activity a WHERE a.uid = s.uid) AND EXISTS (SELECT 1 FROM pricing p WHERE p.uid = s.uid))::BIGINT as tried_and_viewed,
        (SELECT COUNT(*) FROM checkout)::BIGINT as clicked_checkout,
        (SELECT COUNT(*) FROM conversions)::BIGINT as converted;
END;
$$;
