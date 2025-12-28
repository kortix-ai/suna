-- Daily Churn Cache Table
-- Stores churn counts by date (fetched from Stripe, cached in DB)

CREATE TABLE IF NOT EXISTS public.arr_daily_churn (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    churn_date DATE NOT NULL UNIQUE,
    deleted_count INTEGER DEFAULT 0,
    downgrade_count INTEGER DEFAULT 0,
    total_count INTEGER GENERATED ALWAYS AS (deleted_count + downgrade_count) STORED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast date lookups
CREATE INDEX idx_arr_daily_churn_date ON public.arr_daily_churn(churn_date);

-- RLS Policies (super_admin only)
ALTER TABLE public.arr_daily_churn ENABLE ROW LEVEL SECURITY;

-- Allow super_admins to read
CREATE POLICY "Super admins can read arr_daily_churn" ON public.arr_daily_churn
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to insert
CREATE POLICY "Super admins can insert arr_daily_churn" ON public.arr_daily_churn
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to update
CREATE POLICY "Super admins can update arr_daily_churn" ON public.arr_daily_churn
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_arr_daily_churn_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_arr_daily_churn_updated_at
    BEFORE UPDATE ON public.arr_daily_churn
    FOR EACH ROW
    EXECUTE FUNCTION update_arr_daily_churn_updated_at();
