BEGIN;

CREATE OR REPLACE FUNCTION initialize_free_tier_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_initial_credits DECIMAL := 3.0;
    v_rowcount INT;
BEGIN
    IF NEW.personal_account = TRUE THEN
        INSERT INTO public.credit_accounts (
            account_id,
            balance,
            non_expiring_credits,
            expiring_credits,
            tier,
            trial_status,
            last_grant_date
        ) VALUES (
            NEW.id,
            v_initial_credits,
            v_initial_credits,
            0.00,
            'free',
            'none',
            NOW()
        )
        ON CONFLICT (account_id) DO NOTHING;

        GET DIAGNOSTICS v_rowcount = ROW_COUNT;
        
        IF v_rowcount > 0 THEN
            INSERT INTO public.credit_ledger (
                account_id,
                amount,
                balance_after,
                type,
                description
            ) VALUES (
                NEW.id,
                v_initial_credits,
                v_initial_credits,
                'tier_grant',
                'Welcome to Kortix! Free tier initial credits'
            );
            
            RAISE LOG 'Created free tier account for new user % with % credits', NEW.id, v_initial_credits;
        END IF;
    END IF;
    
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Error in initialize_free_tier_credits for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

COMMIT;

