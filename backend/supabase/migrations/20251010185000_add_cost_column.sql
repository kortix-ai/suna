ALTER TABLE public.vapi_calls
ADD COLUMN IF NOT EXISTS cost DECIMAL(10, 6);

COMMENT ON COLUMN public.vapi_calls.cost IS 'Cost of the call in USD';
