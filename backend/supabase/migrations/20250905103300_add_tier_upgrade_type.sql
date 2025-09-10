BEGIN;

ALTER TABLE credit_ledger 
DROP CONSTRAINT IF EXISTS credit_ledger_type_check;

ALTER TABLE credit_ledger 
ADD CONSTRAINT credit_ledger_type_check 
CHECK (type IN ('admin_grant', 'tier_grant', 'tier_upgrade', 'purchase', 'usage', 'refund', 'adjustment', 'expiration'));

COMMIT; 