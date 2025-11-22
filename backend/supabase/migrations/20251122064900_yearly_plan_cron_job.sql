BEGIN;

DO $do$
DECLARE
    v_job_id BIGINT;
BEGIN
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = 'yearly-plan-monthly-refill';
    
    v_job_id := cron.schedule(
        'yearly-plan-monthly-refill',
        '0 1 * * *',
        $$SELECT process_monthly_refills();$$
    );
    
    RAISE NOTICE 'Scheduled yearly plan monthly refill cron job with ID: %', v_job_id;
    RAISE NOTICE 'Cron schedule: Daily at 1:00 AM UTC';
END $do$;

COMMENT ON EXTENSION pg_cron IS 'Job scheduler for PostgreSQL - includes yearly-plan-monthly-refill job that runs daily at 1 AM UTC';

COMMIT;
