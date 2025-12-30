-- Create resources table for sandboxes and future resource types
CREATE TABLE IF NOT EXISTS resources (
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

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_resources_account_id ON resources(account_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_external_id ON resources(external_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);
CREATE INDEX IF NOT EXISTS idx_resources_external_account_type ON resources(external_id, account_id, type);

-- Create unique index for efficient ON CONFLICT deduplication (only on non-null external_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_unique_external_account_type 
ON resources(external_id, account_id, type) 
WHERE external_id IS NOT NULL;

-- Add FK column to projects table (only if it doesn't exist)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = 'projects' 
        AND column_name = 'sandbox_resource_id'
    ) THEN
        ALTER TABLE projects ADD COLUMN sandbox_resource_id UUID REFERENCES resources(id);
    END IF;
END $$;

-- Create index for the FK
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_resource_id ON projects(sandbox_resource_id);

-- Note: Data migration is handled lazily via code in ResourceService.migrate_project_sandbox_if_needed()
-- This allows projects to be migrated on-demand as they are accessed, avoiding long-running migrations

-- Enable RLS on resources table (idempotent - safe to run multiple times)
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Create with error handling to avoid deadlocks
-- Use separate DO blocks to minimize lock contention
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
            EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN
    -- Policy already exists, that's fine
    NULL;
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
            EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN
    NULL;
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
            EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

DO $$
BEGIN
    DROP POLICY IF EXISTS "Account members can delete resources for their accounts" ON resources;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    CREATE POLICY "Account members can delete resources for their accounts"
        ON resources FOR DELETE
        USING (
            EXISTS (
                SELECT 1 FROM basejump.account_user
                WHERE account_user.account_id = resources.account_id
                AND account_user.user_id = auth.uid()
            )
        );
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- Grant permissions (idempotent)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE resources TO authenticated, service_role;

-- Note: The sandbox JSONB column is kept in projects table for now
-- It will be dropped in a future migration once all projects have been lazily migrated
-- Migration happens automatically via ResourceService.migrate_project_sandbox_if_needed()
