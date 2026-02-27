-- Helper function to get full credit breakdown

CREATE OR REPLACE FUNCTION get_credit_breakdown(
    p_account_id UUID
)
RETURNS TABLE(
    total NUMERIC(10, 2),
    daily NUMERIC(10, 2),
    monthly NUMERIC(10, 2),
    extra NUMERIC(10, 2)
)
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(ca.balance, 0) as total,
        COALESCE(ca.daily_credits_balance, 0) as daily,
        COALESCE(ca.expiring_credits, 0) as monthly,
        COALESCE(ca.non_expiring_credits, 0) as extra
    FROM credit_accounts ca
    WHERE ca.account_id = p_account_id;
END;
$$ LANGUAGE plpgsql;

