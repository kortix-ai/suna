BEGIN;

DROP TRIGGER IF EXISTS ensure_billing_customer_email_trigger ON basejump.billing_customers;

DROP FUNCTION IF EXISTS basejump.ensure_billing_customer_email();

DROP FUNCTION IF EXISTS public.get_user_email(UUID);

COMMIT; 