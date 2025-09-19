DROP FUNCTION IF EXISTS get_available_credits(UUID);
DROP FUNCTION IF EXISTS add_credits(UUID, DECIMAL, TEXT, BOOLEAN, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS use_credits(UUID, DECIMAL, TEXT, UUID, UUID);
DROP FUNCTION IF EXISTS reset_expiring_credits(UUID, DECIMAL, TEXT);

DROP FUNCTION IF EXISTS add_credits(UUID, DECIMAL, TEXT);
DROP FUNCTION IF EXISTS use_credits(UUID, DECIMAL, TEXT, UUID, UUID);

DROP FUNCTION IF EXISTS temp_calculate_credit_split(UUID);
DROP FUNCTION IF EXISTS calculate_existing_credit_split(UUID);

COMMENT ON TABLE credit_accounts IS 'Credit management is now handled in Python code (billing.credit_manager) instead of database functions for better maintainability'; 