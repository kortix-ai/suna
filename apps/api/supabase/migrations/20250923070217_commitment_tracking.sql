BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS commitment_type VARCHAR(50),
ADD COLUMN IF NOT EXISTS commitment_start_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS commitment_end_date TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS commitment_price_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS can_cancel_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_commitment 
ON credit_accounts(commitment_end_date) 
WHERE commitment_type IS NOT NULL;

CREATE OR REPLACE FUNCTION can_cancel_subscription(p_account_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_commitment_end_date TIMESTAMPTZ;
    v_commitment_type VARCHAR(50);
BEGIN
    SELECT commitment_end_date, commitment_type
    INTO v_commitment_end_date, v_commitment_type
    FROM credit_accounts
    WHERE account_id = p_account_id;

    IF v_commitment_type IS NULL OR v_commitment_end_date IS NULL THEN
        RETURN TRUE;
    END IF;
    
    IF NOW() >= v_commitment_end_date THEN
        RETURN TRUE;
    END IF;
    
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TABLE IF NOT EXISTS commitment_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    commitment_type VARCHAR(50),
    price_id VARCHAR(255),
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    stripe_subscription_id VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_commitment_history_account ON commitment_history(account_id);
CREATE INDEX IF NOT EXISTS idx_commitment_history_active ON commitment_history(end_date) WHERE cancelled_at IS NULL;

ALTER TABLE commitment_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own commitment history" ON commitment_history
    FOR SELECT USING (auth.uid() = account_id);

CREATE POLICY "Service role can manage commitment history" ON commitment_history
    FOR ALL USING (auth.role() = 'service_role');

COMMIT;
