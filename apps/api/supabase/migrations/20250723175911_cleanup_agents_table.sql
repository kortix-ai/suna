-- Config Single Source of Truth Migration
-- This migration removes all deprecated columns and makes config the only source of agent configuration

BEGIN;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- First, ensure all agents and agent_versions have proper config data
-- by running a final migration of legacy data to config if needed

-- Update ALL agents to ensure config has proper structure
UPDATE agents 
SET config = jsonb_build_object(
    'system_prompt', COALESCE(
        CASE 
            WHEN config ? 'system_prompt' THEN config->>'system_prompt'
            ELSE system_prompt
        END, 
        ''
    ),
    'tools', COALESCE(
        CASE 
            WHEN config ? 'tools' THEN config->'tools'
            ELSE jsonb_build_object(
                'agentpress', (
                    SELECT jsonb_object_agg(
                        key, 
                        (value->>'enabled')::boolean
                    )
                    FROM jsonb_each(COALESCE(agentpress_tools, '{}'::jsonb))
                    WHERE value IS NOT NULL AND value != 'null'::jsonb
                ),
                'mcp', COALESCE(configured_mcps, '[]'::jsonb),
                'custom_mcp', COALESCE(custom_mcps, '[]'::jsonb)
            )
        END,
        jsonb_build_object(
            'agentpress', '{}'::jsonb,
            'mcp', '[]'::jsonb,
            'custom_mcp', '[]'::jsonb
        )
    ),
    'metadata', COALESCE(
        CASE 
            WHEN config ? 'metadata' THEN config->'metadata'
            ELSE jsonb_build_object(
                'avatar', avatar,
                'avatar_color', avatar_color
            )
        END,
        jsonb_build_object(
            'avatar', null,
            'avatar_color', null
        )
    )
);

-- Update ALL agent_versions to ensure config has proper structure
UPDATE agent_versions 
SET config = jsonb_build_object(
    'system_prompt', COALESCE(
        CASE 
            WHEN config ? 'system_prompt' THEN config->>'system_prompt'
            ELSE system_prompt
        END, 
        ''
    ),
    'tools', COALESCE(
        CASE 
            WHEN config ? 'tools' THEN config->'tools'
            ELSE jsonb_build_object(
                'agentpress', (
                    SELECT jsonb_object_agg(
                        key, 
                        (value->>'enabled')::boolean
                    )
                    FROM jsonb_each(COALESCE(agentpress_tools, '{}'::jsonb))
                    WHERE value IS NOT NULL AND value != 'null'::jsonb
                ),
                'mcp', COALESCE(configured_mcps, '[]'::jsonb),
                'custom_mcp', COALESCE(custom_mcps, '[]'::jsonb)
            )
        END,
        jsonb_build_object(
            'agentpress', '{}'::jsonb,
            'mcp', '[]'::jsonb,
            'custom_mcp', '[]'::jsonb
        )
    )
);

-- Drop the deprecated columns from agents table
ALTER TABLE agents DROP COLUMN IF EXISTS system_prompt;
ALTER TABLE agents DROP COLUMN IF EXISTS configured_mcps;
ALTER TABLE agents DROP COLUMN IF EXISTS agentpress_tools;
ALTER TABLE agents DROP COLUMN IF EXISTS custom_mcps;
ALTER TABLE agents DROP COLUMN IF EXISTS avatar;
ALTER TABLE agents DROP COLUMN IF EXISTS avatar_color;

-- Drop the deprecated columns from agent_versions table
ALTER TABLE agent_versions DROP COLUMN IF EXISTS system_prompt;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS configured_mcps;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS agentpress_tools;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS custom_mcps;

-- Update the get_agent_config function to only use config field
CREATE OR REPLACE FUNCTION get_agent_config(p_agent_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_agent RECORD;
BEGIN
    SELECT * INTO v_agent FROM agents WHERE agent_id = p_agent_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Now config is the only source of truth
    RETURN COALESCE(v_agent.config, '{}'::jsonb);
END;
$$;

-- Create a function to get agent version config
CREATE OR REPLACE FUNCTION get_agent_version_config(p_version_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_version RECORD;
BEGIN
    SELECT * INTO v_version FROM agent_versions WHERE version_id = p_version_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Config is the only source of truth for versions too
    RETURN COALESCE(v_version.config, '{}'::jsonb);
END;
$$;

-- Grant permissions on the new function
GRANT EXECUTE ON FUNCTION get_agent_version_config(UUID) TO authenticated, service_role;

-- Add helpful comments
COMMENT ON COLUMN agents.config IS 'Single source of truth for all agent configuration including system_prompt, tools, and metadata';
COMMENT ON COLUMN agent_versions.config IS 'Single source of truth for versioned agent configuration';
COMMENT ON COLUMN agents.metadata IS 'Agent metadata including is_suna_default, centrally_managed flags, and restrictions - crucial for default agent functionality';

-- Ensure config is never null
ALTER TABLE agents ALTER COLUMN config SET NOT NULL;
ALTER TABLE agents ALTER COLUMN config SET DEFAULT '{}'::jsonb;

ALTER TABLE agent_versions ALTER COLUMN config SET NOT NULL;
ALTER TABLE agent_versions ALTER COLUMN config SET DEFAULT '{}'::jsonb;

-- Create optimized indexes for efficient config queries
CREATE INDEX IF NOT EXISTS idx_agents_config_system_prompt ON agents USING gin((config->>'system_prompt') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agents_config_tools ON agents USING gin((config->'tools'));
CREATE INDEX IF NOT EXISTS idx_agent_versions_config_system_prompt ON agent_versions USING gin((config->>'system_prompt') gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_agent_versions_config_tools ON agent_versions USING gin((config->'tools'));

-- Add constraints to ensure config has basic structure
ALTER TABLE agents ADD CONSTRAINT agents_config_structure_check 
CHECK (
    config ? 'system_prompt' AND 
    config ? 'tools' AND 
    config ? 'metadata'
);

ALTER TABLE agent_versions ADD CONSTRAINT agent_versions_config_structure_check 
CHECK (
    config ? 'system_prompt' AND 
    config ? 'tools'
);

COMMIT; 