-- Set lock timeout at session level to avoid lock conflicts
SET lock_timeout = '10min';
SET statement_timeout = '30min';

-- Create resources table for sandboxes and future resource types
-- Use exception handling to gracefully handle existing table
DO $$
BEGIN
    CREATE TABLE resources (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,  -- 'sandbox', 'database', etc.
        external_id TEXT,    -- Daytona sandbox_id
        status TEXT NOT NULL DEFAULT 'active',  -- active, stopped, deleted
        config JSONB DEFAULT '{}'::jsonb,  -- pass, vnc_preview, sandbox_url, token
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
    );
EXCEPTION
    WHEN duplicate_table THEN
        -- Table already exists, that's fine
        RAISE NOTICE 'Table resources already exists, skipping creation';
    WHEN OTHERS THEN
        -- Re-raise other errors
        RAISE;
END $$;

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_resources_account_id ON resources(account_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_external_id ON resources(external_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);
CREATE INDEX IF NOT EXISTS idx_resources_external_account_type ON resources(external_id, account_id, type);

-- Create unique index for efficient ON CONFLICT deduplication (only on non-null external_id)
-- This is critical for fast migration of millions of rows
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_unique_external_account_type 
    ON resources(external_id, account_id, type) 
    WHERE external_id IS NOT NULL;
EXCEPTION WHEN OTHERS THEN
    -- Index might already exist or conflict, that's fine
    NULL;
END $$;

-- Add FK column to projects table
DO $$
BEGIN
    ALTER TABLE projects ADD COLUMN sandbox_resource_id UUID REFERENCES resources(id);
EXCEPTION
    WHEN duplicate_column THEN
        -- Column already exists, that's fine
        RAISE NOTICE 'Column sandbox_resource_id already exists, skipping';
    WHEN OTHERS THEN
        RAISE;
END $$;

-- Create index for the FK
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_resource_id ON projects(sandbox_resource_id);

-- Note: Data migration is handled lazily via code in ResourceService.migrate_project_sandbox_if_needed()
-- This allows projects to be migrated on-demand as they are accessed, avoiding long-running migrations

-- Enable RLS on resources table
DO $$
BEGIN
    ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
EXCEPTION
    WHEN OTHERS THEN
        -- RLS might already be enabled, ignore error
        NULL;
END $$;

-- RLS Policy: Account members can view resources for their accounts
DROP POLICY IF EXISTS "Account members can view resources for their accounts" ON resources;
CREATE POLICY "Account members can view resources for their accounts"
    ON resources FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user
            WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = auth.uid()
        )
    );

-- RLS Policy: Account members can insert resources for their accounts
DROP POLICY IF EXISTS "Account members can insert resources for their accounts" ON resources;
CREATE POLICY "Account members can insert resources for their accounts"
    ON resources FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user
            WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = auth.uid()
        )
    );

-- RLS Policy: Account members can update resources for their accounts
DROP POLICY IF EXISTS "Account members can update resources for their accounts" ON resources;
CREATE POLICY "Account members can update resources for their accounts"
    ON resources FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user
            WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = auth.uid()
        )
    );

-- RLS Policy: Account members can delete resources for their accounts
DROP POLICY IF EXISTS "Account members can delete resources for their accounts" ON resources;
CREATE POLICY "Account members can delete resources for their accounts"
    ON resources FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user
            WHERE account_user.account_id = resources.account_id
            AND account_user.user_id = auth.uid()
        )
    );

-- Grant permissions (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE resources TO authenticated, service_role;

-- Note: The sandbox JSONB column is kept in projects table for now
-- It will be dropped in a future migration once all projects have been lazily migrated
-- Migration happens automatically via ResourceService.migrate_project_sandbox_if_needed()
