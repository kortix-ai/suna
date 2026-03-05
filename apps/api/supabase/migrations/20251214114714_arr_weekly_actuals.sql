-- ARR Weekly Actuals Table
-- Stores actual weekly performance data for ARR simulator comparison

CREATE TABLE IF NOT EXISTS public.arr_weekly_actuals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_number INTEGER NOT NULL UNIQUE CHECK (week_number >= 1 AND week_number <= 52),
    week_start_date DATE NOT NULL,
    views INTEGER DEFAULT 0,
    signups INTEGER DEFAULT 0,
    new_paid INTEGER DEFAULT 0,
    subscribers INTEGER DEFAULT 0,
    mrr NUMERIC(12, 2) DEFAULT 0,
    arr NUMERIC(14, 2) DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for fast lookups by week number
CREATE INDEX IF NOT EXISTS idx_arr_weekly_actuals_week ON public.arr_weekly_actuals(week_number);

-- RLS Policies (super_admin only)
ALTER TABLE public.arr_weekly_actuals ENABLE ROW LEVEL SECURITY;

-- Allow super_admins to read
CREATE POLICY "Super admins can read arr_weekly_actuals" ON public.arr_weekly_actuals
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to insert
CREATE POLICY "Super admins can insert arr_weekly_actuals" ON public.arr_weekly_actuals
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to update
CREATE POLICY "Super admins can update arr_weekly_actuals" ON public.arr_weekly_actuals
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to delete
CREATE POLICY "Super admins can delete arr_weekly_actuals" ON public.arr_weekly_actuals
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_arr_weekly_actuals_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_arr_weekly_actuals_updated_at
    BEFORE UPDATE ON public.arr_weekly_actuals
    FOR EACH ROW
    EXECUTE FUNCTION update_arr_weekly_actuals_updated_at();

