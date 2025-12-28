-- Add platform support to ARR weekly and monthly actuals
-- Platform can be 'web' (auto-synced from Vercel/Stripe) or 'app' (manual/RevenueCat)

-- Add platform column to arr_weekly_actuals
ALTER TABLE public.arr_weekly_actuals
ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web' CHECK (platform IN ('web', 'app'));

-- Drop the old unique constraint on week_number
ALTER TABLE public.arr_weekly_actuals DROP CONSTRAINT IF EXISTS arr_weekly_actuals_week_number_key;

-- Add new unique constraint on (week_number, platform)
ALTER TABLE public.arr_weekly_actuals 
ADD CONSTRAINT arr_weekly_actuals_week_platform_key UNIQUE (week_number, platform);

-- Add platform column to arr_monthly_actuals
ALTER TABLE public.arr_monthly_actuals
ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'web' CHECK (platform IN ('web', 'app'));

-- Drop the old unique constraint on month_index
ALTER TABLE public.arr_monthly_actuals DROP CONSTRAINT IF EXISTS arr_monthly_actuals_month_index_key;

-- Add new unique constraint on (month_index, platform)
ALTER TABLE public.arr_monthly_actuals 
ADD CONSTRAINT arr_monthly_actuals_month_platform_key UNIQUE (month_index, platform);

-- Update indexes to include platform
DROP INDEX IF EXISTS idx_arr_weekly_actuals_week;
CREATE INDEX idx_arr_weekly_actuals_week_platform ON public.arr_weekly_actuals(week_number, platform);

DROP INDEX IF EXISTS idx_arr_monthly_actuals_month_index;
CREATE INDEX idx_arr_monthly_actuals_month_platform ON public.arr_monthly_actuals(month_index, platform);

-- Add comments
COMMENT ON COLUMN public.arr_weekly_actuals.platform IS 
'Platform type: web (auto-synced from Vercel/Stripe) or app (manual entry from RevenueCat)';

COMMENT ON COLUMN public.arr_monthly_actuals.platform IS 
'Platform type: web (auto-synced from Vercel/Stripe) or app (manual entry from RevenueCat)';

