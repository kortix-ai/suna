-- RPC function to get RevenueCat revenue aggregated by tier
-- Parses webhook_events to extract payment info and infer tier from product_id
-- Also returns user emails by joining with billing_customers

CREATE OR REPLACE FUNCTION get_revenuecat_revenue_by_tier(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(
    tier TEXT,
    total_revenue NUMERIC,
    payment_count BIGINT,
    unique_users BIGINT,
    user_emails TEXT[]
) AS $$
BEGIN
    RETURN QUERY
    WITH parsed_events AS (
        SELECT
            we.event_id,
            we.payload->'event'->>'app_user_id' as app_user_id,
            we.payload->'event'->>'product_id' as product_id,
            COALESCE((we.payload->'event'->>'price')::NUMERIC, 0) as price
        FROM webhook_events we
        WHERE we.event_type IN ('INITIAL_PURCHASE', 'RENEWAL')
          AND we.status = 'completed'
          AND we.created_at >= start_date
          AND we.created_at <= end_date
    ),
    filtered_events AS (
        SELECT
            pe.app_user_id,
            pe.product_id,
            pe.price,
            CASE
                WHEN LOWER(pe.product_id) LIKE '%plus%' AND (LOWER(pe.product_id) LIKE '%yearly%' OR LOWER(pe.product_id) LIKE '%annual%') THEN 'tier_2_20_yearly'
                WHEN LOWER(pe.product_id) LIKE '%plus%' THEN 'tier_2_20'
                WHEN LOWER(pe.product_id) LIKE '%pro%' AND (LOWER(pe.product_id) LIKE '%yearly%' OR LOWER(pe.product_id) LIKE '%annual%') THEN 'tier_6_50_yearly'
                WHEN LOWER(pe.product_id) LIKE '%pro%' THEN 'tier_6_50'
                WHEN LOWER(pe.product_id) LIKE '%ultra%' AND (LOWER(pe.product_id) LIKE '%yearly%' OR LOWER(pe.product_id) LIKE '%annual%') THEN 'tier_25_200_yearly'
                WHEN LOWER(pe.product_id) LIKE '%ultra%' THEN 'tier_25_200'
                ELSE 'unknown'
            END as inferred_tier
        FROM parsed_events pe
        WHERE pe.app_user_id IS NOT NULL
          AND pe.app_user_id NOT LIKE '$RCAnonymousID:%'
          AND pe.price > 0
    ),
    events_with_emails AS (
        SELECT
            fe.*,
            bc.email
        FROM filtered_events fe
        LEFT JOIN basejump.billing_customers bc ON fe.app_user_id::uuid = bc.account_id
    )
    SELECT
        ewe.inferred_tier::TEXT as tier,
        SUM(ewe.price)::NUMERIC as total_revenue,
        COUNT(*)::BIGINT as payment_count,
        COUNT(DISTINCT ewe.app_user_id)::BIGINT as unique_users,
        ARRAY_AGG(DISTINCT ewe.email) FILTER (WHERE ewe.email IS NOT NULL) as user_emails
    FROM events_with_emails ewe
    GROUP BY ewe.inferred_tier
    ORDER BY total_revenue DESC;
END;
$$ LANGUAGE plpgsql;
