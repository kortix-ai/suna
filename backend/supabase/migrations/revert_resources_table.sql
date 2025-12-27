-- REVERT Migration: Remove resources table and restore projects to use sandbox JSONB column
-- This reverses the changes made in 20251227000000_resources_table.sql
-- 
-- This migration will:
-- 1. Restore sandbox data from resources table back to projects.sandbox JSONB column
-- 2. Drop the resources table and related structures

BEGIN;

-- Step 0: Ensure sandbox column exists (in case it was dropped)
-- If the column doesn't exist, recreate it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'projects' AND column_name = 'sandbox'
    ) THEN
        ALTER TABLE projects ADD COLUMN sandbox JSONB DEFAULT '{}'::jsonb;
    END IF;
END $$;

-- Step 1: Restore sandbox data from resources table back to projects.sandbox JSONB column
-- Only restore for resources that are linked to projects and are sandbox type
UPDATE projects p
SET sandbox = jsonb_build_object(
    'id', r.external_id,
    'pass', r.config->>'pass',
    'vnc_preview', r.config->>'vnc_preview',
    'sandbox_url', r.config->>'sandbox_url',
    'token', r.config->>'token'
)
FROM resources r
WHERE p.sandbox_resource_id = r.id
  AND r.type = 'sandbox'
  AND r.external_id IS NOT NULL;

-- Step 2: Drop the foreign key constraint and column from projects
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_sandbox_resource_id_fkey;
ALTER TABLE projects DROP COLUMN IF EXISTS sandbox_resource_id;

-- Step 3: Drop indexes
DROP INDEX IF EXISTS idx_projects_sandbox_resource_id;
DROP INDEX IF EXISTS idx_resources_account_id;
DROP INDEX IF EXISTS idx_resources_type;
DROP INDEX IF EXISTS idx_resources_external_id;
DROP INDEX IF EXISTS idx_resources_status;

-- Step 4: Drop RLS policies
DROP POLICY IF EXISTS "Account members can view resources for their accounts" ON resources;
DROP POLICY IF EXISTS "Account members can insert resources for their accounts" ON resources;
DROP POLICY IF EXISTS "Account members can update resources for their accounts" ON resources;
DROP POLICY IF EXISTS "Account members can delete resources for their accounts" ON resources;

-- Step 5: Revoke permissions
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE resources FROM authenticated, service_role;

-- Step 6: Drop the resources table
DROP TABLE IF EXISTS resources;

COMMIT;

