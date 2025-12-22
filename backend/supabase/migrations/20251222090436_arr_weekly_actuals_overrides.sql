-- Add overrides column to arr_weekly_actuals
-- This tracks which fields have been manually overridden by admin
-- When a field is overridden, its value should NOT be replaced by Stripe/API data

-- Add overrides column (JSONB to track per-field overrides)
-- Example: {"views": true, "signups": true, "new_paid": true}
ALTER TABLE public.arr_weekly_actuals
ADD COLUMN IF NOT EXISTS overrides JSONB DEFAULT '{}';

-- Add comment to explain the overrides column
COMMENT ON COLUMN public.arr_weekly_actuals.overrides IS 
'Tracks which fields have been manually overridden by admin. When a field is true in this object, its value should not be overwritten by Stripe/API data. Example: {"views": true, "new_paid": true, "churn": true}';

