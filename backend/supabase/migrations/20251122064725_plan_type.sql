BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS plan_type VARCHAR(50) DEFAULT 'monthly' 
CHECK (plan_type IN ('monthly', 'yearly', 'yearly_commitment'));

UPDATE credit_accounts
SET plan_type = CASE
    WHEN commitment_type = 'yearly_commitment' THEN 'yearly_commitment'
    ELSE 'monthly'
END;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_plan_type 
ON credit_accounts(plan_type);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_yearly_renewal 
ON credit_accounts(plan_type, next_credit_grant) 
WHERE plan_type = 'yearly' AND next_credit_grant IS NOT NULL;

COMMENT ON COLUMN credit_accounts.plan_type IS 'Plan billing type: monthly (pay monthly, get credits monthly), yearly (pay upfront yearly, get credits monthly), yearly_commitment (legacy yearly commitment)';

COMMIT;
