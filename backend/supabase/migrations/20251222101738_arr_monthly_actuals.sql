-- Create monthly actuals table for direct monthly data entry with override support
CREATE TABLE IF NOT EXISTS public.arr_monthly_actuals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    month_index INTEGER NOT NULL UNIQUE, -- 0=Dec 2024, 1=Jan 2025, etc.
    month_name TEXT NOT NULL, -- 'Dec 2024', 'Jan 2025', etc.
    views INTEGER DEFAULT 0,
    signups INTEGER DEFAULT 0,
    new_paid INTEGER DEFAULT 0,
    churn INTEGER DEFAULT 0,
    subscribers INTEGER DEFAULT 0,
    mrr NUMERIC(12,2) DEFAULT 0,
    arr NUMERIC(12,2) DEFAULT 0,
    overrides JSONB DEFAULT '{}', -- Per-field override flags
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_arr_monthly_actuals_month_index ON public.arr_monthly_actuals(month_index);

-- Add RLS policies (assuming admins only)
ALTER TABLE public.arr_monthly_actuals ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read
CREATE POLICY "Allow authenticated read" ON public.arr_monthly_actuals
    FOR SELECT TO authenticated USING (true);

-- Allow authenticated users to insert/update (will be further restricted by API)
CREATE POLICY "Allow authenticated insert" ON public.arr_monthly_actuals
    FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Allow authenticated update" ON public.arr_monthly_actuals
    FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Allow authenticated delete" ON public.arr_monthly_actuals
    FOR DELETE TO authenticated USING (true);

