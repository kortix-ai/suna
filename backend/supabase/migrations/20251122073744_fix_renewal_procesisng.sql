BEGIN;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT conname INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'public.renewal_processing'::regclass
    AND contype = 'c'
    AND conname LIKE '%processed_by%'
    LIMIT 1;
    
    IF constraint_name IS NOT NULL THEN
        EXECUTE 'ALTER TABLE public.renewal_processing DROP CONSTRAINT ' || quote_ident(constraint_name);
        RAISE NOTICE 'Dropped existing constraint: %', constraint_name;
    ELSE
        RAISE NOTICE 'No existing processed_by constraint found';
    END IF;
    
    ALTER TABLE public.renewal_processing 
    ADD CONSTRAINT renewal_processing_processed_by_check 
    CHECK (processed_by IN ('webhook_invoice', 'webhook_subscription', 'manual', 'cron', 'revenuecat_webhook'));
    
    RAISE NOTICE 'Added new constraint allowing cron as processed_by value';
END $$;

COMMIT;
