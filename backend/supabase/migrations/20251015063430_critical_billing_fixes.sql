CREATE TABLE IF NOT EXISTS public.webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    processing_started_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    payload JSONB,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhook_events_event_id ON public.webhook_events(event_id);
CREATE INDEX idx_webhook_events_created_at ON public.webhook_events(created_at DESC);
CREATE INDEX idx_webhook_events_status ON public.webhook_events(status) WHERE status IN ('pending', 'failed');

COMMENT ON TABLE public.webhook_events IS 'Tracks all Stripe webhook events for idempotency and debugging';

CREATE TABLE IF NOT EXISTS public.renewal_processing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    period_start BIGINT NOT NULL,
    period_end BIGINT NOT NULL,
    subscription_id TEXT NOT NULL,
    processed_by TEXT NOT NULL CHECK (processed_by IN ('webhook_invoice', 'webhook_subscription', 'manual')),
    credits_granted NUMERIC(10, 2) NOT NULL,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    stripe_event_id TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(account_id, period_start)
);

CREATE INDEX idx_renewal_processing_account ON public.renewal_processing(account_id);
CREATE INDEX idx_renewal_processing_period ON public.renewal_processing(account_id, period_start);
CREATE INDEX idx_renewal_processing_subscription ON public.renewal_processing(subscription_id);

COMMENT ON TABLE public.renewal_processing IS 'Tracks renewal credit grants to prevent duplicates';

ALTER TABLE public.trial_history 
    DROP CONSTRAINT IF EXISTS unique_account_trial;

ALTER TABLE public.trial_history
    ADD CONSTRAINT unique_account_trial UNIQUE (account_id);

CREATE INDEX IF NOT EXISTS idx_trial_history_account_id ON public.trial_history(account_id);
CREATE INDEX IF NOT EXISTS idx_trial_history_started_at ON public.trial_history(started_at DESC);

CREATE TABLE IF NOT EXISTS public.refund_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL,
    stripe_refund_id TEXT UNIQUE NOT NULL,
    stripe_charge_id TEXT NOT NULL,
    stripe_payment_intent_id TEXT,
    amount_refunded NUMERIC(10, 2) NOT NULL,
    credits_deducted NUMERIC(10, 2) NOT NULL DEFAULT 0,
    refund_reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'failed')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_refund_history_account ON public.refund_history(account_id);
CREATE INDEX idx_refund_history_stripe_refund ON public.refund_history(stripe_refund_id);
CREATE INDEX idx_refund_history_status ON public.refund_history(status) WHERE status IN ('pending', 'failed');

COMMENT ON TABLE public.refund_history IS 'Tracks all refunds and associated credit deductions';

CREATE TABLE IF NOT EXISTS public.distributed_locks (
    lock_key TEXT PRIMARY KEY,
    holder_id TEXT NOT NULL,
    acquired_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_distributed_locks_expires ON public.distributed_locks(expires_at);

COMMENT ON TABLE public.distributed_locks IS 'Distributed locking for critical operations (fallback if Redis unavailable)';

CREATE OR REPLACE FUNCTION acquire_distributed_lock(
    p_lock_key TEXT,
    p_holder_id TEXT,
    p_timeout_seconds INTEGER DEFAULT 300
) RETURNS BOOLEAN AS $$
DECLARE
    v_expires_at TIMESTAMP WITH TIME ZONE;
    v_acquired BOOLEAN;
BEGIN
    v_expires_at := NOW() + (p_timeout_seconds || ' seconds')::INTERVAL;
    
    DELETE FROM public.distributed_locks 
    WHERE lock_key = p_lock_key AND expires_at < NOW();
    
    BEGIN
        INSERT INTO public.distributed_locks (lock_key, holder_id, expires_at)
        VALUES (p_lock_key, p_holder_id, v_expires_at);
        v_acquired := TRUE;
    EXCEPTION WHEN unique_violation THEN
        v_acquired := FALSE;
    END;
    
    RETURN v_acquired;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_distributed_lock(
    p_lock_key TEXT,
    p_holder_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.distributed_locks 
    WHERE lock_key = p_lock_key AND holder_id = p_holder_id;
    
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted > 0;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE public.credit_ledger
    ADD COLUMN IF NOT EXISTS processing_source TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_credit_ledger_idempotency ON public.credit_ledger(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.credit_accounts
    ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS reconciliation_discrepancy NUMERIC(10, 2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS needs_reconciliation BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_credit_accounts_needs_reconciliation 
    ON public.credit_accounts(needs_reconciliation) WHERE needs_reconciliation = TRUE;

ALTER TABLE public.credit_purchases
    ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_reconciliation_attempt TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_credit_purchases_reconciled 
    ON public.credit_purchases(status, reconciled_at) 
    WHERE status = 'pending' AND reconciled_at IS NULL;

CREATE OR REPLACE FUNCTION cleanup_old_webhook_events() RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.webhook_events
    WHERE created_at < NOW() - INTERVAL '30 days'
      AND status = 'completed';
    
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_webhook_events IS 'Removes webhook events older than 30 days (completed only)';

ALTER TABLE public.credit_accounts
    DROP CONSTRAINT IF EXISTS check_balance_non_negative,
    ADD CONSTRAINT check_balance_non_negative CHECK (balance >= 0);

ALTER TABLE public.credit_accounts
    DROP CONSTRAINT IF EXISTS check_expiring_non_negative,
    ADD CONSTRAINT check_expiring_non_negative CHECK (expiring_credits >= 0);

ALTER TABLE public.credit_accounts
    DROP CONSTRAINT IF EXISTS check_non_expiring_non_negative,
    ADD CONSTRAINT check_non_expiring_non_negative CHECK (non_expiring_credits >= 0);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.renewal_processing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refund_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.distributed_locks ENABLE ROW LEVEL SECURITY;


CREATE POLICY "Service role full access on webhook_events" ON public.webhook_events
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on renewal_processing" ON public.renewal_processing
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on refund_history" ON public.refund_history
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Service role full access on distributed_locks" ON public.distributed_locks
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view own refund history" ON public.refund_history
    FOR SELECT USING (
        account_id IN (
            SELECT id FROM basejump.accounts 
            WHERE primary_owner_user_id = auth.uid()
        )
    );


DROP VIEW IF EXISTS public.billing_health_check CASCADE;

CREATE VIEW public.billing_health_check AS
SELECT 
    'webhook_processing_failures' as metric,
    COUNT(*) as value,
    NOW() as checked_at
FROM public.webhook_events
WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours'
UNION ALL
SELECT 
    'pending_reconciliations' as metric,
    COUNT(*) as value,
    NOW() as checked_at
FROM public.credit_purchases
WHERE status = 'pending' AND created_at > NOW() - INTERVAL '24 hours'
UNION ALL
SELECT 
    'trial_starts_today' as metric,
    COUNT(*) as value,
    NOW() as checked_at
FROM public.trial_history
WHERE started_at::date = CURRENT_DATE
UNION ALL
SELECT 
    'refunds_unprocessed' as metric,
    COUNT(*) as value,
    NOW() as checked_at
FROM public.refund_history
WHERE status = 'pending';

COMMENT ON VIEW public.billing_health_check IS 'Real-time billing system health metrics';

GRANT SELECT, INSERT, UPDATE ON public.webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.renewal_processing TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.refund_history TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.distributed_locks TO service_role;
GRANT SELECT ON public.billing_health_check TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'P0 Critical Billing Fixes Migration Completed Successfully';
    RAISE NOTICE 'Tables created: webhook_events, renewal_processing, refund_history, distributed_locks';
    RAISE NOTICE 'Constraints added: unique_account_trial on trial_history';
    RAISE NOTICE 'Functions created: acquire_distributed_lock, release_distributed_lock, cleanup_old_webhook_events';
END $$;

