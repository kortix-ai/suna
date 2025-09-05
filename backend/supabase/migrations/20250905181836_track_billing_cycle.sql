BEGIN;

ALTER TABLE credit_accounts 
ADD COLUMN IF NOT EXISTS billing_cycle_anchor TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS next_credit_grant TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_next_grant 
ON credit_accounts(next_credit_grant) 
WHERE next_credit_grant IS NOT NULL;

CREATE OR REPLACE FUNCTION calculate_next_billing_date(
    anchor_date TIMESTAMPTZ,
    from_date TIMESTAMPTZ DEFAULT NOW()
) RETURNS TIMESTAMPTZ AS $$
DECLARE
    months_diff INT;
    next_date TIMESTAMPTZ;
BEGIN
    IF anchor_date IS NULL THEN
        RETURN NULL;
    END IF;
    
    months_diff := EXTRACT(YEAR FROM from_date) * 12 + EXTRACT(MONTH FROM from_date) -
                   (EXTRACT(YEAR FROM anchor_date) * 12 + EXTRACT(MONTH FROM anchor_date));
    
    IF from_date < anchor_date THEN
        RETURN anchor_date;
    END IF;
    
    next_date := anchor_date + INTERVAL '1 month' * (months_diff + 1);
    
    IF EXTRACT(DAY FROM anchor_date) > EXTRACT(DAY FROM next_date) THEN
        next_date := date_trunc('month', next_date) + INTERVAL '1 month' - INTERVAL '1 day';
    END IF;
    
    RETURN next_date;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

UPDATE credit_accounts ca
SET 
    stripe_subscription_id = bs.id,
    billing_cycle_anchor = bs.created::timestamptz,
    next_credit_grant = CASE
        WHEN ca.last_grant_date IS NOT NULL 
            AND ca.last_grant_date > NOW() - INTERVAL '25 days'
        THEN calculate_next_billing_date(bs.created::timestamptz, ca.last_grant_date)
        ELSE calculate_next_billing_date(bs.created::timestamptz, NOW())
    END
FROM basejump.billing_subscriptions bs
WHERE bs.account_id = ca.user_id
  AND bs.status IN ('active', 'trialing');

DO $$
DECLARE
    migrated_count INT;
    users_with_recent_grants INT;
BEGIN
    SELECT COUNT(*) INTO migrated_count
    FROM credit_accounts 
    WHERE billing_cycle_anchor IS NOT NULL;
    
    SELECT COUNT(*) INTO users_with_recent_grants
    FROM credit_accounts
    WHERE last_grant_date > NOW() - INTERVAL '25 days'
      AND billing_cycle_anchor IS NOT NULL;
    
    RAISE NOTICE 'Migration complete: % users migrated to billing cycle system', migrated_count;
    RAISE NOTICE 'Users with recent grants (protected from double-crediting): %', users_with_recent_grants;
END $$;

COMMIT; 