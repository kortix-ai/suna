ALTER TABLE referral_codes 
DROP CONSTRAINT IF EXISTS referral_codes_account_id_key;

ALTER TABLE referral_codes 
DROP CONSTRAINT IF EXISTS referral_codes_user_id_key;

CREATE INDEX IF NOT EXISTS idx_referral_codes_account_active 
ON referral_codes(account_id) 
WHERE expired_at IS NULL;
