-- Remove Workflow System Migration
-- This migration removes all workflow/playbook tables and related database objects

-- Create backup of workflow tables before dropping
CREATE TABLE IF NOT EXISTS agent_workflows_backup AS SELECT * FROM agent_workflows;

-- Drop workflow tables (with CASCADE to handle foreign keys)
DROP TABLE IF EXISTS agent_workflows CASCADE;