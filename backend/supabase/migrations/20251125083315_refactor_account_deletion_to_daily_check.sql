BEGIN;

-- Refactor account deletion to use daily check instead of individual cron jobs
-- This is simpler, more reliable, and easier to monitor

-- Function to process all scheduled account deletions that are due
CREATE OR REPLACE FUNCTION process_scheduled_account_deletions()
RETURNS TABLE(
    processed_count INTEGER,
    deleted_accounts INTEGER,
    errors INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_deletion_request RECORD;
    v_account_id UUID;
    v_user_id UUID;
    v_processed INTEGER := 0;
    v_deleted INTEGER := 0;
    v_errors INTEGER := 0;
BEGIN
    RAISE NOTICE 'Starting daily account deletion check at %', NOW();
    
    -- Find all deletion requests that are due and not cancelled/deleted
    FOR v_deletion_request IN
        SELECT id, account_id, user_id
        FROM account_deletion_requests
        WHERE deletion_scheduled_for <= NOW()
          AND is_cancelled = FALSE
          AND is_deleted = FALSE
        ORDER BY deletion_scheduled_for ASC
    LOOP
        v_processed := v_processed + 1;
        v_account_id := v_deletion_request.account_id;
        v_user_id := v_deletion_request.user_id;
        
        RAISE NOTICE 'Processing deletion request: %, account: %, user: %', 
            v_deletion_request.id, v_account_id, v_user_id;
        
        BEGIN
            -- Delete Daytona sandboxes via HTTP endpoint before deleting account data
            BEGIN
                PERFORM net.http_post(
                    url := 'https://staging-api.suna.so/api/internal/delete-account-sandboxes',
                    headers := json_build_object(
                        'Content-Type', 'application/json',
                        'X-Admin-Api-Key', 'ACTUAL_KEY_GOES_HERE_JUST_RUN_IN_SQL_EDITOR_WITH_ACTUAL_KEY'
                    )::jsonb,
                    body := json_build_object('account_id', v_account_id)::text::jsonb,
                    timeout_milliseconds := 30000
                );
                RAISE NOTICE 'Requested sandbox deletion for account: %', v_account_id;
            EXCEPTION WHEN OTHERS THEN
                RAISE WARNING 'Failed to delete sandboxes via HTTP for account %: %', v_account_id, SQLERRM;
                -- Continue with deletion even if sandbox deletion fails
            END;
            
            -- Delete account data
            IF delete_user_data(v_account_id, v_user_id) THEN
                -- Mark deletion request as completed
                UPDATE account_deletion_requests
                SET is_deleted = TRUE,
                    deleted_at = NOW(),
                    updated_at = NOW()
                WHERE id = v_deletion_request.id;
                
                -- Delete auth user
                BEGIN
                    DELETE FROM auth.users WHERE id = v_user_id;
                    RAISE NOTICE 'Deleted auth user: %', v_user_id;
                EXCEPTION WHEN OTHERS THEN
                    RAISE WARNING 'Error deleting auth user %: %', v_user_id, SQLERRM;
                END;
                
                v_deleted := v_deleted + 1;
                RAISE NOTICE 'Successfully processed deletion for account: %', v_account_id;
            ELSE
                RAISE WARNING 'Failed to delete data for account: %', v_account_id;
                v_errors := v_errors + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Error processing deletion request %: %', v_deletion_request.id, SQLERRM;
            v_errors := v_errors + 1;
        END;
    END LOOP;
    
    RAISE NOTICE 'Daily deletion check completed. Processed: %, Deleted: %, Errors: %', 
        v_processed, v_deleted, v_errors;
    
    RETURN QUERY SELECT v_processed, v_deleted, v_errors;
END;
$$;

GRANT EXECUTE ON FUNCTION process_scheduled_account_deletions() TO service_role;

-- Clean up any existing individual deletion cron jobs from the old system
DO $do$
DECLARE
    v_job RECORD;
    v_cleaned INTEGER := 0;
BEGIN
    -- Find and unschedule all old individual deletion jobs
    FOR v_job IN
        SELECT jobid, jobname
        FROM cron.job
        WHERE jobname LIKE 'delete-account-%'
    LOOP
        BEGIN
            PERFORM cron.unschedule(v_job.jobid);
            v_cleaned := v_cleaned + 1;
            RAISE NOTICE 'Cleaned up old individual deletion job: % (id: %)', v_job.jobname, v_job.jobid;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Failed to clean up job %: %', v_job.jobname, SQLERRM;
        END;
    END LOOP;
    
    IF v_cleaned > 0 THEN
        RAISE NOTICE 'Cleaned up % old individual deletion cron jobs', v_cleaned;
    END IF;
END $do$;

-- Create daily cron job to process scheduled deletions
-- Runs every day at 1:00 AM UTC
DO $do$
DECLARE
    v_job_id BIGINT;
BEGIN
    -- Unschedule any existing job with the same name
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = 'process-scheduled-account-deletions';
    
    -- Schedule the daily job
    v_job_id := cron.schedule(
        'process-scheduled-account-deletions',
        '0 1 * * *',  -- Daily at 1:00 AM UTC
        $$SELECT process_scheduled_account_deletions();$$
    );
    
    RAISE NOTICE 'Scheduled daily account deletion check cron job with ID: %', v_job_id;
    RAISE NOTICE 'Cron schedule: Daily at 1:00 AM UTC';
END $do$;

-- Remove old individual job scheduling functions (keep for backward compatibility but make them no-ops)
CREATE OR REPLACE FUNCTION schedule_account_deletion(
    p_deletion_request_id UUID,
    p_scheduled_time TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- No-op: Individual jobs are no longer scheduled
    -- Deletions are processed by the daily check job instead
    RAISE NOTICE 'Account deletion scheduled (will be processed by daily check): request_id: %, scheduled_for: %', 
        p_deletion_request_id, p_scheduled_time;
    RETURN 'scheduled-via-daily-check';
END;
$$;

CREATE OR REPLACE FUNCTION cancel_account_deletion_job(p_deletion_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- No-op: Individual jobs are no longer used
    -- Cancellation is handled by updating is_cancelled flag in the table
    RAISE NOTICE 'Account deletion cancellation handled via table flag: request_id: %', p_deletion_request_id;
    RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION process_scheduled_account_deletions IS 'Processes all account deletions scheduled for today or earlier. Called daily by cron job.';
COMMENT ON FUNCTION schedule_account_deletion IS 'Deprecated: No longer schedules individual jobs. Deletions are processed by daily check.';
COMMENT ON FUNCTION cancel_account_deletion_job IS 'Deprecated: No longer cancels individual jobs. Cancellation handled via table flag.';

COMMIT;

