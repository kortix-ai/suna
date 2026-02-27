DO $$
BEGIN
    -- Drop constraint if it exists
    ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_type_check;
    
    -- Add constraint only if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conrelid = 'public.credit_ledger'::regclass 
        AND conname = 'credit_ledger_type_check'
    ) THEN
        ALTER TABLE credit_ledger
        ADD CONSTRAINT credit_ledger_type_check 
        CHECK (type IN (
            'tier_grant', 'purchase', 'admin_grant', 'promotional',
            'usage', 'refund', 'adjustment', 'expired', 'tier_upgrade', 
            'daily_grant', 'daily_refresh'
        ));
    END IF;
END $$;
