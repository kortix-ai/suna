BEGIN;

-- Create credit_ledger table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    amount DECIMAL(10, 2) NOT NULL,
    balance_after DECIMAL(10, 2) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'refund', 'purchase', 'trial', 'admin_grant', 'admin_deduct', 'subscription', 'tier_upgrade')),
    description TEXT,
    reference_id UUID,
    reference_type TEXT,
    is_expiring BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_id ON public.credit_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_type ON public.credit_ledger(type);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_reference ON public.credit_ledger(reference_id, reference_type);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_expiry ON public.credit_ledger(account_id, is_expiring, expires_at);

-- Enable RLS
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own ledger" ON public.credit_ledger;
DROP POLICY IF EXISTS "Service role manages ledger" ON public.credit_ledger;

-- Create RLS policies
CREATE POLICY "Users can view own ledger" ON public.credit_ledger
    FOR SELECT USING (auth.uid() = account_id);

CREATE POLICY "Service role manages ledger" ON public.credit_ledger
    FOR ALL USING (auth.role() = 'service_role');

-- Grant permissions
GRANT SELECT ON public.credit_ledger TO authenticated;
GRANT ALL ON public.credit_ledger TO service_role;

COMMIT;
