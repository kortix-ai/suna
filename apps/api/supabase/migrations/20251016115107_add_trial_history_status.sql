ALTER TABLE public.trial_history 
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' 
CHECK (status IN ('checkout_pending', 'checkout_created', 'checkout_failed', 'active', 'expired', 'converted', 'cancelled'));

ALTER TABLE public.trial_history 
ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS idx_trial_history_status 
ON public.trial_history(status) 
WHERE status IN ('checkout_pending', 'checkout_failed');

UPDATE public.trial_history 
SET status = 'active' 
WHERE status IS NULL;

COMMENT ON COLUMN public.trial_history.status IS 
'Trial checkout/activation status: checkout_pending (awaiting payment), checkout_created (Stripe session created), checkout_failed (error), active (trial running), expired (trial ended), converted (became paying customer), cancelled (trial cancelled)';

COMMENT ON COLUMN public.trial_history.error_message IS 
'Error details if checkout failed';

DO $$
BEGIN
    RAISE NOTICE '✅ Added status and error_message columns to trial_history table';
    RAISE NOTICE '   - status: tracks trial checkout and lifecycle state';
    RAISE NOTICE '   - error_message: stores checkout failure details';
    RAISE NOTICE '   - Index created for pending/failed checkout tracking';
END $$;
