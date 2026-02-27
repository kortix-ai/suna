ALTER TABLE resources ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE resources 
ADD COLUMN IF NOT EXISTS pooled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_resources_pooled 
ON resources(status, type, pooled_at) 
WHERE status = 'pooled' AND type = 'sandbox';

CREATE INDEX IF NOT EXISTS idx_resources_pooled_fifo
ON resources(pooled_at ASC)
WHERE status = 'pooled' AND type = 'sandbox';

DO $$
BEGIN
    DROP POLICY IF EXISTS "Account members can view resources for their accounts" ON resources;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    CREATE POLICY "Account members can view resources for their accounts"
        ON resources FOR SELECT
        USING (
            account_id IS NULL
            OR EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Account members can insert resources for their accounts" ON resources;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    CREATE POLICY "Account members can insert resources for their accounts"
        ON resources FOR INSERT
        WITH CHECK (
            account_id IS NULL
            OR EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Account members can update resources for their accounts" ON resources;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    CREATE POLICY "Account members can update resources for their accounts"
        ON resources FOR UPDATE
        USING (
            account_id IS NULL
            OR EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION claim_pooled_sandbox(
    p_account_id UUID,
    p_project_id UUID,
    p_updated_at TIMESTAMPTZ
)
RETURNS TABLE (
    id UUID,
    external_id TEXT,
    config JSONB
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_resource_id UUID;
    v_external_id TEXT;
    v_config JSONB;
BEGIN
    SELECT r.id, r.external_id, r.config
    INTO v_resource_id, v_external_id, v_config
    FROM resources r
    WHERE r.type = 'sandbox'
      AND r.status = 'pooled'
    ORDER BY r.pooled_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    IF v_resource_id IS NULL THEN
        RETURN;
    END IF;
    
    UPDATE resources
    SET account_id = p_account_id,
        status = 'active',
        updated_at = p_updated_at,
        pooled_at = NULL
    WHERE resources.id = v_resource_id;
    
    RETURN QUERY SELECT v_resource_id, v_external_id, v_config;
END;
$$;
