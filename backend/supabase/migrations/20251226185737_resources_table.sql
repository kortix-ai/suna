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

-- Add FK column to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_resource_id UUID REFERENCES resources(id);

-- Create index for the FK
CREATE INDEX IF NOT EXISTS idx_projects_sandbox_resource_id ON projects(sandbox_resource_id);

-- Migrate existing sandbox data from projects.sandbox JSONB to resources table
-- Only insert if resource doesn't already exist (by external_id + account_id)
INSERT INTO resources (account_id, type, external_id, config, created_at, updated_at)
SELECT 
    account_id,
    'sandbox',
    sandbox->>'id',
    jsonb_build_object(
        'pass', sandbox->>'pass',
        'vnc_preview', sandbox->>'vnc_preview',
        'sandbox_url', sandbox->>'sandbox_url',
        'token', sandbox->>'token'
    ),
    created_at,
    updated_at
FROM projects 
WHERE sandbox IS NOT NULL 
  AND sandbox->>'id' IS NOT NULL
  AND sandbox != '{}'::jsonb
  AND NOT EXISTS (
      SELECT 1 FROM resources r 
      WHERE r.external_id = sandbox->>'id' 
      AND r.account_id = projects.account_id
      AND r.type = 'sandbox'
  );

-- Link projects to migrated resources
UPDATE projects p
SET sandbox_resource_id = r.id
FROM resources r
WHERE r.external_id = p.sandbox->>'id'
  AND r.account_id = p.account_id
  AND p.sandbox_resource_id IS NULL
  AND p.sandbox->>'id' IS NOT NULL;

-- Enable RLS on resources table
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

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

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE resources TO authenticated, service_role;

-- Drop the old sandbox JSONB column from projects table
-- All data has been migrated to the resources table above
ALTER TABLE projects DROP COLUMN IF EXISTS sandbox;
