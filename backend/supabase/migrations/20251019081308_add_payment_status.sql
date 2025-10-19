ALTER TABLE public.credit_accounts 
    ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'active' 
        CHECK (payment_status IN ('active', 'failed', 'pending', 'past_due'));

ALTER TABLE public.credit_accounts 
    ADD COLUMN IF NOT EXISTS last_payment_failure TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.credit_accounts.payment_status IS 'Tracks the current payment status of the subscription';
COMMENT ON COLUMN public.credit_accounts.last_payment_failure IS 'Timestamp of the last payment failure';

CREATE INDEX IF NOT EXISTS idx_credit_accounts_payment_status 
    ON public.credit_accounts(payment_status) 
    WHERE payment_status != 'active';
