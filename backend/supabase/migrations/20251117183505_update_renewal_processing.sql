ALTER TABLE public.renewal_processing 
DROP CONSTRAINT IF EXISTS renewal_processing_processed_by_check;

ALTER TABLE public.renewal_processing 
ADD CONSTRAINT renewal_processing_processed_by_check 
CHECK (processed_by IN ('webhook_invoice', 'webhook_subscription', 'manual', 'revenuecat_webhook'));

ALTER TABLE public.renewal_processing
ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'stripe' CHECK (provider IN ('stripe', 'revenuecat'));

ALTER TABLE public.renewal_processing
ADD COLUMN IF NOT EXISTS revenuecat_transaction_id TEXT,
ADD COLUMN IF NOT EXISTS revenuecat_product_id TEXT;

CREATE INDEX IF NOT EXISTS idx_renewal_processing_provider ON public.renewal_processing(provider);

UPDATE public.renewal_processing SET provider = 'stripe' WHERE provider IS NULL;
