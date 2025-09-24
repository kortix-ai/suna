-- Fix credit_ledger type constraint to include 'usage' type
ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_type_check;

ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_type_check 
    CHECK (type IN ('credit', 'debit', 'refund', 'purchase', 'trial', 'admin_grant', 'admin_deduct', 'subscription', 'tier_upgrade', 'usage'));
