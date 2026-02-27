DROP VIEW IF EXISTS public.billing_health_check CASCADE;

DO $$
BEGIN
    RAISE NOTICE '✅ Removed billing_health_check view';
END $$;
