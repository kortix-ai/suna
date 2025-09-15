-- NOTE: This migration has been rolled back by 20250910103000_rollback_oauth_email_fix.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.get_user_email(user_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    user_email TEXT;
BEGIN
    SELECT email INTO user_email
    FROM auth.users
    WHERE id = user_id;
    
    IF user_email IS NULL THEN
        SELECT 
            COALESCE(
                raw_user_meta_data->>'email',
                raw_user_meta_data->>'user_email',
                email
            ) INTO user_email
        FROM auth.users
        WHERE id = user_id;
    END IF;
    
    RETURN user_email;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_user_email(UUID) TO authenticated, service_role;

DO $$
DECLARE
    rec RECORD;
    user_email TEXT;
BEGIN
    FOR rec IN 
        SELECT bc.account_id, a.primary_owner_user_id
        FROM basejump.billing_customers bc
        JOIN basejump.accounts a ON bc.account_id = a.id
        WHERE bc.email IS NULL OR bc.email = ''
    LOOP
        user_email := public.get_user_email(rec.primary_owner_user_id);
        
        IF user_email IS NOT NULL THEN
            UPDATE basejump.billing_customers
            SET email = user_email
            WHERE account_id = rec.account_id;
            
            RAISE NOTICE 'Updated email for account %: %', rec.account_id, user_email;
        END IF;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION basejump.ensure_billing_customer_email()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    user_email TEXT;
    owner_id UUID;
BEGIN
    IF NEW.email IS NULL OR NEW.email = '' THEN
        SELECT primary_owner_user_id INTO owner_id
        FROM basejump.accounts
        WHERE id = NEW.account_id;
        
        user_email := public.get_user_email(owner_id);
        
        IF user_email IS NOT NULL THEN
            NEW.email := user_email;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_billing_customer_email_trigger ON basejump.billing_customers;
CREATE TRIGGER ensure_billing_customer_email_trigger
    BEFORE INSERT OR UPDATE ON basejump.billing_customers
    FOR EACH ROW
    EXECUTE FUNCTION basejump.ensure_billing_customer_email();

COMMIT; 