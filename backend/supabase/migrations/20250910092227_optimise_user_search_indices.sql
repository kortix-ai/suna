CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_billing_customers_email_gin 
    ON basejump.billing_customers 
    USING gin (lower(email) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_customers_account_id 
    ON basejump.billing_customers (account_id);

CREATE INDEX IF NOT EXISTS idx_accounts_created_at_desc 
    ON basejump.accounts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_account_id 
    ON public.credit_accounts (account_id);

CREATE INDEX IF NOT EXISTS idx_credit_accounts_tier 
    ON public.credit_accounts (tier);

CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at_desc 
    ON public.agent_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_account_id 
    ON public.threads (account_id);

ANALYZE basejump.billing_customers;
ANALYZE basejump.accounts;
ANALYZE public.credit_accounts;
ANALYZE public.agent_runs;
ANALYZE public.threads; 
