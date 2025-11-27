-- Grant permissions for all credit-related functions
DO $$
BEGIN
    GRANT EXECUTE ON FUNCTION atomic_use_credits(UUID, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION atomic_daily_credit_refresh(UUID, NUMERIC, TEXT, TEXT, INTEGER) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION get_credit_breakdown(UUID) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION atomic_grant_renewal_credits(UUID, BIGINT, BIGINT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
END $$;

