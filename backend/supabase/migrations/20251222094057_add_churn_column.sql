-- Add churn column to arr_weekly_actuals for manual override of churn data
ALTER TABLE public.arr_weekly_actuals
ADD COLUMN IF NOT EXISTS churn INTEGER DEFAULT 0;

