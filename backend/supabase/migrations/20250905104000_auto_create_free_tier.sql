BEGIN;

SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION initialize_free_tier_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_initial_credits DECIMAL := 5.0;
    v_transaction_id UUID;
    v_rowcount INT;
BEGIN
    IF NEW.personal_account = TRUE THEN
        INSERT INTO public.credit_accounts (
            user_id,
            balance,
            tier,
            last_grant_date
        ) VALUES (
            NEW.id,
            v_initial_credits,
            'free',
            NOW()
        )
        ON CONFLICT (user_id) DO NOTHING;

        GET DIAGNOSTICS v_rowcount = ROW_COUNT;
        IF v_rowcount > 0 THEN
            INSERT INTO public.credit_ledger (
                user_id,
                amount,
                balance_after,
                type,
                description
            ) VALUES (
                NEW.id,
                v_initial_credits,
                v_initial_credits,
                'tier_grant',
                'Welcome to Suna! Free tier initial credits'
            ) RETURNING id INTO v_transaction_id;
            
            RAISE LOG 'Created free tier credits for new user %: % credits', NEW.id, v_initial_credits;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_create_free_tier_on_account ON basejump.accounts;

CREATE TRIGGER auto_create_free_tier_on_account
    AFTER INSERT ON basejump.accounts
    FOR EACH ROW
    EXECUTE FUNCTION initialize_free_tier_credits();

DO $$
DECLARE
    account_record RECORD;
    v_initial_credits DECIMAL := 5.0;
    v_created_count INTEGER := 0;
BEGIN
    FOR account_record IN 
        SELECT a.id, a.created_at
        FROM basejump.accounts a
        LEFT JOIN public.credit_accounts ca ON ca.user_id = a.id
        WHERE a.personal_account = TRUE
        AND ca.user_id IS NULL
    LOOP
        INSERT INTO public.credit_accounts (
            user_id,
            balance,
            tier,
            last_grant_date
        ) VALUES (
            account_record.id,
            v_initial_credits,
            'free',
            account_record.created_at
        );
        
        INSERT INTO public.credit_ledger (
            user_id,
            amount,
            balance_after,
            type,
            description,
            created_at
        ) VALUES (
            account_record.id,
            v_initial_credits,
            v_initial_credits,
            'tier_grant',
            'Free tier initial credits (backfilled)',
            account_record.created_at
        );
        
        v_created_count := v_created_count + 1;
    END LOOP;
    
    IF v_created_count > 0 THEN
        RAISE NOTICE 'Created free tier credits for % existing users', v_created_count;
    END IF;
END;
$$;

COMMIT;
