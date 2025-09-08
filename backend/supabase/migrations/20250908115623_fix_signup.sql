CREATE OR REPLACE FUNCTION initialize_free_tier_credits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.personal_account = TRUE THEN
        INSERT INTO public.credit_accounts (
            account_id,
            balance,
            tier,
            trial_status,
            last_grant_date
        ) VALUES (
            NEW.id,
            0.00,
            'none',
            'none',
            NOW()
        )
        ON CONFLICT (account_id) DO NOTHING;
        RAISE LOG 'Created account for new user % with no credits (must start trial)', NEW.id;
    END IF;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Error in initialize_free_tier_credits for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$; 