-- RPC function to get active subscription counts (paid tiers only)
CREATE OR REPLACE FUNCTION get_active_subscription_counts()
RETURNS TABLE (
    stripe_paid BIGINT,
    revenuecat_paid BIGINT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        COUNT(*) FILTER (WHERE stripe_subscription_id IS NOT NULL AND tier NOT IN ('free', 'none')) as stripe_paid,
        COUNT(*) FILTER (WHERE revenuecat_subscription_id IS NOT NULL AND tier NOT IN ('free', 'none')) as revenuecat_paid
    FROM credit_accounts;
$$;

-- Grant execute permission to service_role only (admin backend)
GRANT EXECUTE ON FUNCTION get_active_subscription_counts() TO service_role;
