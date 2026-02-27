ALTER TABLE public.credit_accounts
    ADD COLUMN IF NOT EXISTS last_renewal_period_start BIGINT;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_last_renewal_period 
    ON public.credit_accounts(account_id, last_renewal_period_start);

