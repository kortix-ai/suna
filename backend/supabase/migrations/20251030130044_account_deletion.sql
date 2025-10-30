BEGIN;

CREATE TABLE IF NOT EXISTS account_deletion_requests (
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
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_active_deletion_request UNIQUE NULLS NOT DISTINCT (account_id, is_deleted, is_cancelled)
);

CREATE INDEX idx_account_deletion_requests_account_id ON account_deletion_requests(account_id);
CREATE INDEX idx_account_deletion_requests_user_id ON account_deletion_requests(user_id);
CREATE INDEX idx_account_deletion_requests_scheduled ON account_deletion_requests(deletion_scheduled_for) WHERE is_cancelled = FALSE AND is_deleted = FALSE;
CREATE INDEX idx_account_deletion_requests_status ON account_deletion_requests(is_cancelled, is_deleted);

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

    DELETE FROM messages WHERE thread_id IN (
        SELECT thread_id FROM threads WHERE account_id = p_account_id
    );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % messages', v_row_count;

    DELETE FROM threads WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % threads', v_row_count;

    DELETE FROM agent_runs WHERE project_id IN (
        SELECT project_id FROM projects WHERE account_id = p_account_id
    );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % agent_runs', v_row_count;

    DELETE FROM agent_versions WHERE agent_id IN (
        SELECT agent_id FROM agents WHERE account_id = p_account_id
    );
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % agent_versions', v_row_count;

    DELETE FROM agents WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % agents', v_row_count;

    DELETE FROM projects WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % projects', v_row_count;

    DELETE FROM user_mcp_credentials WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % user_mcp_credentials', v_row_count;

    DELETE FROM agent_templates WHERE creator_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % agent_templates', v_row_count;

    DELETE FROM knowledge_bases WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % knowledge_bases', v_row_count;

    DELETE FROM devices WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % devices', v_row_count;

    DELETE FROM api_keys WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % api_keys', v_row_count;

    DELETE FROM google_oauth_tokens WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % google_oauth_tokens', v_row_count;

    DELETE FROM credit_grants WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % credit_grants', v_row_count;

    DELETE FROM credit_ledger WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % credit_ledger', v_row_count;

    DELETE FROM credit_accounts WHERE user_id = p_user_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % credit_accounts', v_row_count;

    DELETE FROM basejump.billing_subscriptions WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % billing_subscriptions', v_row_count;

    DELETE FROM basejump.billing_customers WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % billing_customers', v_row_count;

    DELETE FROM basejump.account_user WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % account_user', v_row_count;

    DELETE FROM account_deletion_requests WHERE account_id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % account_deletion_requests', v_row_count;

    DELETE FROM basejump.accounts WHERE id = p_account_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % accounts', v_row_count;

    RAISE NOTICE 'Completed deletion for account_id: %', p_account_id;
    
    RETURN TRUE;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error deleting user data: %', SQLERRM;
        RETURN FALSE;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_user_data(UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION process_scheduled_account_deletions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deletion_request RECORD;
BEGIN
    FOR deletion_request IN
        SELECT id, account_id, user_id
        FROM account_deletion_requests
        WHERE deletion_scheduled_for <= NOW()
          AND is_cancelled = FALSE
          AND is_deleted = FALSE
    LOOP
        RAISE NOTICE 'Processing deletion for account_id: %', deletion_request.account_id;
        
        IF delete_user_data(deletion_request.account_id, deletion_request.user_id) THEN
            UPDATE account_deletion_requests
            SET is_deleted = TRUE,
                deleted_at = NOW(),
                updated_at = NOW()
            WHERE id = deletion_request.id;
            
            RAISE NOTICE 'Successfully marked deletion request as completed: %', deletion_request.id;
        ELSE
            RAISE WARNING 'Failed to delete data for account_id: %', deletion_request.account_id;
        END IF;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION process_scheduled_account_deletions() TO service_role;

SELECT cron.schedule(
    'process-account-deletions',
    '0 2 * * *',
    $$SELECT process_scheduled_account_deletions();$$
);

COMMIT;

