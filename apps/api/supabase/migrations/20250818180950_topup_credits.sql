CREATE TABLE IF NOT EXISTS public.credit_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_dollars DECIMAL(10, 2) NOT NULL CHECK (amount_dollars > 0),
    stripe_payment_intent_id TEXT UNIQUE,
    stripe_charge_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    CONSTRAINT credit_purchases_amount_positive CHECK (amount_dollars > 0)
);

CREATE TABLE IF NOT EXISTS public.credit_balance (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    balance_dollars DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (balance_dollars >= 0),
    total_purchased DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_purchased >= 0),
    total_used DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_used >= 0),
    last_updated TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS public.credit_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    amount_dollars DECIMAL(10, 2) NOT NULL CHECK (amount_dollars > 0),
    thread_id UUID REFERENCES public.threads(thread_id) ON DELETE SET NULL,
    message_id UUID REFERENCES public.messages(message_id) ON DELETE SET NULL,
    description TEXT,
    usage_type TEXT DEFAULT 'token_overage' CHECK (usage_type IN ('token_overage', 'manual_deduction', 'adjustment')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    subscription_tier TEXT,
    metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_credit_purchases_user_id ON public.credit_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_status ON public.credit_purchases(status);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_created_at ON public.credit_purchases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_purchases_stripe_payment_intent ON public.credit_purchases(stripe_payment_intent_id);

CREATE INDEX IF NOT EXISTS idx_credit_usage_user_id ON public.credit_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_usage_created_at ON public.credit_usage(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_usage_thread_id ON public.credit_usage(thread_id);

ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view their own credit purchases" ON public.credit_purchases;
DROP POLICY IF EXISTS "Service role can manage all credit purchases" ON public.credit_purchases;
DROP POLICY IF EXISTS "Users can view their own credit balance" ON public.credit_balance;
DROP POLICY IF EXISTS "Service role can manage all credit balances" ON public.credit_balance;
DROP POLICY IF EXISTS "Users can view their own credit usage" ON public.credit_usage;
DROP POLICY IF EXISTS "Service role can manage all credit usage" ON public.credit_usage;

CREATE POLICY "Users can view their own credit purchases" ON public.credit_purchases
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all credit purchases" ON public.credit_purchases
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view their own credit balance" ON public.credit_balance
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all credit balances" ON public.credit_balance
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Users can view their own credit usage" ON public.credit_usage
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all credit usage" ON public.credit_usage
    FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.add_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_purchase_id UUID DEFAULT NULL
)
RETURNS DECIMAL
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_balance DECIMAL;
BEGIN
    INSERT INTO public.credit_balance (user_id, balance_dollars, total_purchased)
    VALUES (p_user_id, p_amount, p_amount)
    ON CONFLICT (user_id) DO UPDATE
    SET 
        balance_dollars = credit_balance.balance_dollars + p_amount,
        total_purchased = credit_balance.total_purchased + p_amount,
        last_updated = NOW()
    RETURNING balance_dollars INTO new_balance;
    
    RETURN new_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.use_credits(
    p_user_id UUID,
    p_amount DECIMAL,
    p_description TEXT DEFAULT NULL,
    p_thread_id UUID DEFAULT NULL,
    p_message_id UUID DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    current_balance DECIMAL;
    success BOOLEAN := FALSE;
BEGIN
    SELECT balance_dollars INTO current_balance
    FROM public.credit_balance
    WHERE user_id = p_user_id
    FOR UPDATE;
    
    IF current_balance IS NOT NULL AND current_balance >= p_amount THEN
        UPDATE public.credit_balance
        SET 
            balance_dollars = balance_dollars - p_amount,
            total_used = total_used + p_amount,
            last_updated = NOW()
        WHERE user_id = p_user_id;
        
        INSERT INTO public.credit_usage (
            user_id, 
            amount_dollars, 
            description, 
            thread_id, 
            message_id,
            usage_type
        )
        VALUES (
            p_user_id, 
            p_amount, 
            p_description, 
            p_thread_id, 
            p_message_id,
            'token_overage'
        );
        
        success := TRUE;
    END IF;
    
    RETURN success;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_credit_balance(p_user_id UUID)
RETURNS DECIMAL
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    balance DECIMAL;
BEGIN
    SELECT balance_dollars INTO balance
    FROM public.credit_balance
    WHERE user_id = p_user_id;
    
    RETURN COALESCE(balance, 0);
END;
$$;

GRANT SELECT ON public.credit_purchases TO authenticated;
GRANT SELECT ON public.credit_balance TO authenticated;
GRANT SELECT ON public.credit_usage TO authenticated;

GRANT ALL ON public.credit_purchases TO service_role;
GRANT ALL ON public.credit_balance TO service_role;
GRANT ALL ON public.credit_usage TO service_role;

GRANT EXECUTE ON FUNCTION public.add_credits TO service_role;
GRANT EXECUTE ON FUNCTION public.use_credits TO service_role;
GRANT EXECUTE ON FUNCTION public.get_credit_balance TO authenticated, service_role; 