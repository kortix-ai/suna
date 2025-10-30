BEGIN;

DROP TABLE IF EXISTS account_deletion_requests CASCADE;
DROP FUNCTION IF EXISTS delete_user_data(UUID, UUID);
DROP FUNCTION IF EXISTS process_scheduled_account_deletions();

CREATE TABLE account_deletion_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deletion_scheduled_for TIMESTAMPTZ NOT NULL,
    reason TEXT,
    is_cancelled BOOLEAN DEFAULT FALSE,
    cancelled_at TIMESTAMPTZ,
    is_deleted BOOLEAN DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_account_deletion_requests_account_id ON account_deletion_requests(account_id);
CREATE INDEX idx_account_deletion_requests_user_id ON account_deletion_requests(user_id);
CREATE INDEX idx_account_deletion_requests_scheduled ON account_deletion_requests(deletion_scheduled_for) 
    WHERE is_cancelled = FALSE AND is_deleted = FALSE;
CREATE INDEX idx_account_deletion_requests_status ON account_deletion_requests(is_cancelled, is_deleted);

CREATE UNIQUE INDEX unique_active_deletion_request 
ON account_deletion_requests (account_id) 
WHERE is_cancelled = FALSE AND is_deleted = FALSE;

ALTER TABLE account_deletion_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own deletion requests" ON account_deletion_requests
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage deletion requests" ON account_deletion_requests
    FOR ALL USING (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION delete_user_data(p_account_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_row_count INTEGER := 0;
BEGIN
    RAISE NOTICE 'Starting deletion for account_id: %, user_id: %', p_account_id, p_user_id;

    BEGIN
        DELETE FROM agent_runs WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_runs', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_runs: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM messages WHERE thread_id IN (
            SELECT thread_id FROM threads WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % messages', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting messages: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM threads WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % threads', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting threads: %', SQLERRM;
    END;

    BEGIN
        UPDATE agents 
        SET current_version_id = NULL 
        WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Nullified current_version_id for % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error nullifying agent versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agent_versions WHERE agent_id IN (
            SELECT agent_id FROM agents WHERE account_id = p_account_id
        );
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_versions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_versions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM agents WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agents', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agents: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM projects WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % projects', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting projects: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM agent_templates WHERE creator_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % agent_templates', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting agent_templates: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM api_keys WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % api_keys', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting api_keys: %', SQLERRM;
    END;


    BEGIN
        DELETE FROM credit_accounts WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % credit_accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting credit_accounts: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_subscriptions WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_subscriptions', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_subscriptions: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.billing_customers WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % billing_customers', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting billing_customers: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.account_user WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_user', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_user: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM account_deletion_requests WHERE account_id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % account_deletion_requests', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting account_deletion_requests: %', SQLERRM;
    END;

    BEGIN
        DELETE FROM basejump.accounts WHERE id = p_account_id;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        RAISE NOTICE 'Deleted % accounts', v_row_count;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Error deleting accounts: %', SQLERRM;
    END;

    RAISE NOTICE 'Completed deletion for account_id: %', p_account_id;
    RETURN TRUE;

EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Critical error in delete_user_data: %', SQLERRM;
        RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_user_data(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION execute_account_deletion(p_deletion_request_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_account_id UUID;
    v_user_id UUID;
    v_job_name TEXT;
BEGIN
    SELECT account_id, user_id 
    INTO v_account_id, v_user_id
    FROM account_deletion_requests
    WHERE id = p_deletion_request_id
      AND is_cancelled = FALSE
      AND is_deleted = FALSE;
    
    IF v_account_id IS NULL THEN
        RAISE NOTICE 'Deletion request % not found or already processed', p_deletion_request_id;
        RETURN;
    END IF;
    
    RAISE NOTICE 'Executing deletion for request: %, account: %, user: %', p_deletion_request_id, v_account_id, v_user_id;
    
    IF delete_user_data(v_account_id, v_user_id) THEN
        UPDATE account_deletion_requests
        SET is_deleted = TRUE,
            deleted_at = NOW(),
            updated_at = NOW()
        WHERE id = p_deletion_request_id;
        
        RAISE NOTICE 'Marked deletion request % as completed', p_deletion_request_id;
        
        BEGIN
            DELETE FROM auth.users WHERE id = v_user_id;
            RAISE NOTICE 'Deleted auth user: %', v_user_id;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Error deleting auth user %: %', v_user_id, SQLERRM;
        END;
        
        v_job_name := 'delete-account-' || p_deletion_request_id::text;
        PERFORM cancel_account_deletion_job(p_deletion_request_id);
        RAISE NOTICE 'Self-cleaning: unscheduled cron job: %', v_job_name;
    ELSE
        RAISE WARNING 'Failed to delete data for account: %', v_account_id;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION execute_account_deletion(UUID) TO service_role;

CREATE OR REPLACE FUNCTION schedule_account_deletion(
    p_deletion_request_id UUID,
    p_scheduled_time TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job_name TEXT;
    v_cron_schedule TEXT;
    v_job_id BIGINT;
BEGIN
    v_job_name := 'delete-account-' || p_deletion_request_id::text;
    
    v_cron_schedule := to_char(p_scheduled_time, 'MI HH DD MM') || ' *';
    
    BEGIN
        v_job_id := cron.schedule(
            v_job_name,
            v_cron_schedule,
            format('SELECT execute_account_deletion(%L::uuid)', p_deletion_request_id)
        );
        
        RAISE NOTICE 'Scheduled deletion job: % at %', v_job_name, p_scheduled_time;
        RETURN v_job_name;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to schedule deletion job: %', SQLERRM;
        RETURN NULL;
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION schedule_account_deletion(UUID, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION cancel_account_deletion_job(p_deletion_request_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job_name TEXT;
    v_job_id BIGINT;
BEGIN
    v_job_name := 'delete-account-' || p_deletion_request_id::text;
    
    SELECT jobid INTO v_job_id
    FROM cron.job
    WHERE jobname = v_job_name;
    
    IF v_job_id IS NULL THEN
        RAISE NOTICE 'No cron job found with name: %', v_job_name;
        RETURN TRUE;
    END IF;
    
    BEGIN
        PERFORM cron.unschedule(v_job_id);
        RAISE NOTICE 'Cancelled deletion job: % (id: %)', v_job_name, v_job_id;
        RETURN TRUE;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to cancel deletion job: %', SQLERRM;
        RETURN FALSE;
    END;
END;
$$;

GRANT EXECUTE ON FUNCTION cancel_account_deletion_job(UUID) TO service_role;

CREATE OR REPLACE FUNCTION delete_user_immediately(p_account_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RAISE NOTICE 'Immediate deletion for account: %, user: %', p_account_id, p_user_id;
    
    IF delete_user_data(p_account_id, p_user_id) THEN
        BEGIN
            DELETE FROM auth.users WHERE id = p_user_id;
            RAISE NOTICE 'Deleted auth user: %', p_user_id;
            RETURN TRUE;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'Error deleting auth user %: %', p_user_id, SQLERRM;
            RETURN FALSE;
        END;
    ELSE
        RETURN FALSE;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_user_immediately(UUID, UUID) TO service_role;

COMMIT;

