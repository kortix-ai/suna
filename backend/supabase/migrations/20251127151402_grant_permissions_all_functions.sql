-- Grant permissions for all credit-related functions
-- GRANT is idempotent, but wrapping in DO block for safety
DO $$
BEGIN
    -- These will succeed even if permissions already exist
    GRANT EXECUTE ON FUNCTION atomic_use_credits(UUID, NUMERIC, TEXT, TEXT, TEXT) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION atomic_daily_credit_refresh(UUID, NUMERIC, TEXT, TEXT, INTEGER) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION get_credit_breakdown(UUID) TO authenticated, service_role;
    GRANT EXECUTE ON FUNCTION atomic_grant_renewal_credits(UUID, BIGINT, BIGINT, NUMERIC, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
EXCEPTION WHEN OTHERS THEN
    -- Ignore errors (permissions might already exist or function might not exist yet)
    NULL;
END $$;

