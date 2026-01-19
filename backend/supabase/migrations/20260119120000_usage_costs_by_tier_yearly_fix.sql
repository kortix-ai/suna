-- Fix: Distinguish yearly vs monthly users in usage costs by tier
-- This aligns usage cost grouping with revenue grouping (which shows yearly tiers separately)
--
-- Problem: Revenue shows "Ultra" and "Ultra Yearly" separately, but usage costs
-- groups all Ultra users together, causing incorrect profit calculations.

CREATE OR REPLACE FUNCTION get_usage_costs_by_tier(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ
)
RETURNS TABLE(tier TEXT, provider TEXT, user_count BIGINT, total_cost NUMERIC) AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE
            WHEN ca.plan_type IN ('yearly', 'yearly_commitment')
            THEN COALESCE(ca.tier, 'unknown') || '_yearly'
            ELSE COALESCE(ca.tier, 'unknown')
        END::TEXT as tier,
        COALESCE(ca.provider, 'stripe')::TEXT as provider,
        COUNT(DISTINCT cl.account_id)::BIGINT as user_count,
        SUM(ABS(cl.amount))::NUMERIC as total_cost
    FROM credit_ledger cl
    LEFT JOIN credit_accounts ca ON cl.account_id = ca.account_id
    WHERE cl.type = 'usage'
      AND cl.created_at >= start_date
      AND cl.created_at <= end_date
    GROUP BY
        CASE
            WHEN ca.plan_type IN ('yearly', 'yearly_commitment')
            THEN COALESCE(ca.tier, 'unknown') || '_yearly'
            ELSE COALESCE(ca.tier, 'unknown')
        END,
        ca.provider
    ORDER BY total_cost DESC;
END;
$$ LANGUAGE plpgsql;
