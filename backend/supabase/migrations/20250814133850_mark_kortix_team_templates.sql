-- Migration: Mark Kortix team templates
-- This migration marks templates created by the Kortix team as official

BEGIN;

-- Update templates to mark as Kortix team based on specific criteria
-- You can adjust the WHERE clause based on your actual Kortix team account IDs or template names

-- Option 1: Mark templates by specific names that are known Kortix team templates
UPDATE agent_templates
SET is_kortix_team = true
WHERE name IN (
    'Sheets Agent',
    'Slides Agent', 
    'Data Analyst',
    'Web Dev Agent',
    'Research Assistant',
    'Code Review Agent',
    'Documentation Writer',
    'API Testing Agent'
) AND is_public = true;

-- Option 2: Mark templates by creator_id if you know the Kortix team account IDs
-- Uncomment and modify with actual Kortix team account IDs
-- UPDATE agent_templates
-- SET is_kortix_team = true
-- WHERE creator_id IN (
--     'kortix-team-account-id-1',
--     'kortix-team-account-id-2'
-- );

-- Option 3: Mark templates that have specific metadata indicating they're official
UPDATE agent_templates
SET is_kortix_team = true
WHERE metadata->>'is_suna_default' = 'true'
   OR metadata->>'is_official' = 'true';

-- Log the update
DO $$
DECLARE
    updated_count INTEGER;
BEGIN
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Marked % templates as Kortix team templates', updated_count;
END $$;

