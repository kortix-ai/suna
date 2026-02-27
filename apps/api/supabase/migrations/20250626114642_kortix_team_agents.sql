-- Migration: Add is_kortix_team field to agent_templates
-- This migration adds support for marking templates as Kortix team templates

BEGIN;

-- Add is_kortix_team column to agent_templates table
ALTER TABLE agent_templates ADD COLUMN IF NOT EXISTS is_kortix_team BOOLEAN DEFAULT false;

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_agent_templates_is_kortix_team ON agent_templates(is_kortix_team);

-- Add comment
COMMENT ON COLUMN agent_templates.is_kortix_team IS 'Indicates if this template is created by the Kortix team (official templates)';

COMMIT; 