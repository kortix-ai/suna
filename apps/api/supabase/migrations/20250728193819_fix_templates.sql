-- Safe Templates Config Structure Migration for Production
-- This migration safely updates agent_templates to use the unified config structure
-- with proper existence checks for production environments

BEGIN;

-- Function to check if column exists
CREATE OR REPLACE FUNCTION column_exists(p_table_name text, p_column_name text) 
RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
        AND table_name = p_table_name 
        AND column_name = p_column_name
    );
END;
$$ LANGUAGE plpgsql;

-- Function to check if constraint exists
CREATE OR REPLACE FUNCTION constraint_exists(p_table_name text, p_constraint_name text) 
RETURNS boolean AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 
        FROM information_schema.table_constraints 
        WHERE table_schema = 'public' 
        AND table_name = p_table_name 
        AND constraint_name = p_constraint_name
    );
END;
$$ LANGUAGE plpgsql;

-- Backup existing templates if not already done
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'agent_templates_backup') THEN
        CREATE TABLE agent_templates_backup AS SELECT * FROM agent_templates;
    END IF;
END
$$;

-- Add config column if it doesn't exist
DO $$
BEGIN
    IF NOT column_exists('agent_templates', 'config') THEN
        ALTER TABLE agent_templates ADD COLUMN config JSONB DEFAULT '{}'::jsonb;
    END IF;
END
$$;

-- Migrate data from old structure to new config structure (only if old columns exist)
DO $$
BEGIN
    -- Only migrate if we have old columns and config is empty
    IF column_exists('agent_templates', 'system_prompt') AND 
       column_exists('agent_templates', 'agentpress_tools') THEN
        
        UPDATE agent_templates 
        SET config = jsonb_build_object(
            'system_prompt', COALESCE(system_prompt, ''),
            'tools', jsonb_build_object(
                'agentpress', COALESCE(agentpress_tools, '{}'::jsonb),
                'mcp', '[]'::jsonb,
                'custom_mcp', COALESCE(
                    CASE 
                        WHEN column_exists('agent_templates', 'mcp_requirements') 
                        THEN mcp_requirements 
                        ELSE '[]'::jsonb 
                    END, 
                    '[]'::jsonb
                )
            ),
            'metadata', jsonb_build_object(
                'avatar', avatar,
                'avatar_color', avatar_color,
                'template_metadata', COALESCE(metadata, '{}'::jsonb)
            )
        )
        WHERE config = '{}'::jsonb OR config IS NULL;
    END IF;
END
$$;

-- Drop old columns if they exist
DO $$
BEGIN
    IF column_exists('agent_templates', 'system_prompt') THEN
        ALTER TABLE agent_templates DROP COLUMN system_prompt;
    END IF;
    
    IF column_exists('agent_templates', 'mcp_requirements') THEN
        ALTER TABLE agent_templates DROP COLUMN mcp_requirements;
    END IF;
    
    IF column_exists('agent_templates', 'agentpress_tools') THEN
        ALTER TABLE agent_templates DROP COLUMN agentpress_tools;
    END IF;
END
$$;

-- Add constraints if they don't exist
DO $$
BEGIN
    IF NOT constraint_exists('agent_templates', 'agent_templates_config_structure_check') THEN
        ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_config_structure_check 
        CHECK (
            config ? 'system_prompt' AND 
            config ? 'tools' AND 
            config ? 'metadata'
        );
    END IF;
    
    IF NOT constraint_exists('agent_templates', 'agent_templates_tools_structure_check') THEN
        ALTER TABLE agent_templates ADD CONSTRAINT agent_templates_tools_structure_check 
        CHECK (
            config->'tools' ? 'agentpress' AND
            config->'tools' ? 'mcp' AND
            config->'tools' ? 'custom_mcp'
        );
    END IF;
END
$$;

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_id ON agent_templates(creator_id);
CREATE INDEX IF NOT EXISTS idx_agent_templates_is_public ON agent_templates(is_public);
CREATE INDEX IF NOT EXISTS idx_agent_templates_marketplace_published_at ON agent_templates(marketplace_published_at);
CREATE INDEX IF NOT EXISTS idx_agent_templates_download_count ON agent_templates(download_count);
CREATE INDEX IF NOT EXISTS idx_agent_templates_tags ON agent_templates USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_agent_templates_created_at ON agent_templates(created_at);

-- Add config-specific indexes
CREATE INDEX IF NOT EXISTS idx_agent_templates_config_tools ON agent_templates USING gin((config->'tools'));
CREATE INDEX IF NOT EXISTS idx_agent_templates_config_agentpress ON agent_templates USING gin((config->'tools'->'agentpress'));

-- Add sanitization function for template creation
CREATE OR REPLACE FUNCTION sanitize_config_for_template(input_config JSONB)
RETURNS JSONB AS $$
DECLARE
    sanitized_config JSONB;
    custom_mcp_array JSONB;
    custom_mcp_item JSONB;
    sanitized_mcp JSONB;
    result_array JSONB := '[]'::jsonb;
BEGIN
    -- Start with the basic structure
    sanitized_config := jsonb_build_object(
        'system_prompt', COALESCE(input_config->>'system_prompt', ''),
        'tools', jsonb_build_object(
            'agentpress', COALESCE(input_config->'tools'->'agentpress', '{}'::jsonb),
            'mcp', COALESCE(input_config->'tools'->'mcp', '[]'::jsonb),
            'custom_mcp', '[]'::jsonb
        ),
        'metadata', jsonb_build_object(
            'avatar', input_config->'metadata'->>'avatar',
            'avatar_color', input_config->'metadata'->>'avatar_color'
        )
    );
    
    -- Get custom_mcp array safely
    custom_mcp_array := COALESCE(input_config->'tools'->'custom_mcp', '[]'::jsonb);
    
    -- Process each custom MCP item
    FOR custom_mcp_item IN SELECT jsonb_array_elements(custom_mcp_array)
    LOOP
        -- Create sanitized MCP item
        sanitized_mcp := jsonb_build_object(
            'name', custom_mcp_item->>'name',
            'type', custom_mcp_item->>'type',
            'display_name', COALESCE(custom_mcp_item->>'display_name', custom_mcp_item->>'name'),
            'enabledTools', COALESCE(custom_mcp_item->'enabledTools', '[]'::jsonb)
        );
        
        -- Add config based on type
        IF custom_mcp_item->>'type' = 'pipedream' THEN
            -- For pipedream, keep URL but remove profile_id from headers
            sanitized_mcp := jsonb_set(
                sanitized_mcp,
                '{config}',
                jsonb_build_object(
                    'url', custom_mcp_item->'config'->>'url',
                    'headers', COALESCE(custom_mcp_item->'config'->'headers', '{}'::jsonb) - 'profile_id'
                )
            );
        ELSE
            -- For other types (like http with secure URLs), remove all config
            sanitized_mcp := jsonb_set(sanitized_mcp, '{config}', '{}'::jsonb);
        END IF;
        
        -- Add to result array
        result_array := result_array || sanitized_mcp;
    END LOOP;
    
    -- Update sanitized config with cleaned custom_mcps
    sanitized_config := jsonb_set(
        sanitized_config,
        '{tools,custom_mcp}',
        result_array
    );
    
    RETURN sanitized_config;
END;
$$ LANGUAGE plpgsql;

-- Create function to increment download count
CREATE OR REPLACE FUNCTION increment_template_download_count(template_id_param UUID)
RETURNS void AS $$
BEGIN
    UPDATE agent_templates 
    SET download_count = download_count + 1,
        updated_at = NOW()
    WHERE template_id = template_id_param;
END;
$$ LANGUAGE plpgsql;

-- Enable RLS if not already enabled
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;

-- Drop and recreate RLS policies to ensure they're current
DROP POLICY IF EXISTS "Users can view public templates or their own templates" ON agent_templates;
CREATE POLICY "Users can view public templates or their own templates" ON agent_templates
    FOR SELECT USING (
        is_public = true OR 
        creator_id = (auth.jwt() ->> 'sub')::uuid
    );

DROP POLICY IF EXISTS "Users can create their own templates" ON agent_templates;
CREATE POLICY "Users can create their own templates" ON agent_templates
    FOR INSERT WITH CHECK (creator_id = (auth.jwt() ->> 'sub')::uuid);

DROP POLICY IF EXISTS "Users can update their own templates" ON agent_templates;
CREATE POLICY "Users can update their own templates" ON agent_templates
    FOR UPDATE USING (creator_id = (auth.jwt() ->> 'sub')::uuid);

DROP POLICY IF EXISTS "Users can delete their own templates" ON agent_templates;
CREATE POLICY "Users can delete their own templates" ON agent_templates
    FOR DELETE USING (creator_id = (auth.jwt() ->> 'sub')::uuid);

-- Clean up helper functions
DROP FUNCTION IF EXISTS column_exists(text, text);
DROP FUNCTION IF EXISTS constraint_exists(text, text);

COMMIT; 