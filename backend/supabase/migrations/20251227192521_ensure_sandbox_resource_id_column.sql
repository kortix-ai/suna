-- Migration: Ensure sandbox_resource_id column exists on projects table
-- This migration ensures the resources table and sandbox_resource_id FK exist

-- Step 1: Ensure resources table exists
CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    external_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

-- Step 2: Create indexes for resources table
CREATE INDEX IF NOT EXISTS idx_resources_account_id ON resources(account_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_external_id ON resources(external_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(status);

-- Step 3: Add sandbox_resource_id column to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_resource_id UUID REFERENCES resources(id);

-- Step 4: Create index for the FK
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_resource_id ON projects(sandbox_resource_id);

-- Step 5: Enable RLS on resources table
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

-- Step 6: Create RLS policies for resources table
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

-- Step 7: Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE resources TO authenticated, service_role;
