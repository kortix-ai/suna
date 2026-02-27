-- RPC function to get usage costs aggregated by tier
-- This is much more efficient than fetching all 278k+ accounts client-side

CREATE OR REPLACE FUNCTION get_usage_costs_by_tier(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(tier TEXT, provider TEXT, user_count BIGINT, total_cost NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COALESCE(ca.tier, 'unknown')::TEXT as tier,
        COALESCE(ca.provider, 'stripe')::TEXT as provider,
        COUNT(DISTINCT cl.account_id)::BIGINT as user_count,
        SUM(ABS(cl.amount))::NUMERIC as total_cost
    FROM credit_ledger cl
    LEFT JOIN credit_accounts ca ON cl.account_id = ca.account_id
    WHERE cl.type = 'usage'
      AND cl.created_at >= start_date
      AND cl.created_at <= end_date
    GROUP BY ca.tier, ca.provider
    ORDER BY total_cost DESC;
END;
$$ LANGUAGE plpgsql;
