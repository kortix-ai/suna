-- ARR Simulator Config Table
-- Stores the simulator configuration parameters (single row)

CREATE TABLE IF NOT EXISTS public.arr_simulator_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    starting_subs INTEGER DEFAULT 639,
    starting_mrr NUMERIC(12, 2) DEFAULT 21646,
    weekly_visitors INTEGER DEFAULT 40000,
    landing_conversion NUMERIC(5, 2) DEFAULT 25,
    signup_to_paid NUMERIC(5, 2) DEFAULT 1,
    arpu NUMERIC(10, 2) DEFAULT 34,
    monthly_churn NUMERIC(5, 2) DEFAULT 25,
    visitor_growth NUMERIC(5, 2) DEFAULT 5,
    target_arr NUMERIC(14, 2) DEFAULT 10000000,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default config row
INSERT INTO public.arr_simulator_config (id) VALUES (gen_random_uuid());

-- RLS Policies (super_admin only)
ALTER TABLE public.arr_simulator_config ENABLE ROW LEVEL SECURITY;

-- Allow super_admins to read
CREATE POLICY "Super admins can read arr_simulator_config" ON public.arr_simulator_config
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Allow super_admins to update
CREATE POLICY "Super admins can update arr_simulator_config" ON public.arr_simulator_config
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
            AND ur.role = 'super_admin'
        )
    );

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_arr_simulator_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_arr_simulator_config_updated_at
    BEFORE UPDATE ON public.arr_simulator_config
    FOR EACH ROW
    EXECUTE FUNCTION update_arr_simulator_config_updated_at();

