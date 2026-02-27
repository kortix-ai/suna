BEGIN;

-- =====================================================
-- SECURE MCP CREDENTIAL ARCHITECTURE MIGRATION
-- =====================================================
-- This migration implements a secure architecture where:
-- 1. Agent templates contain MCP requirements (no credentials)
-- 2. User credentials are stored encrypted separately
-- 3. Agent instances combine templates with user credentials at runtime

-- =====================================================
-- 1. AGENT TEMPLATES TABLE
-- =====================================================
-- Stores marketplace agent templates without any credentials
CREATE TABLE IF NOT EXISTS agent_templates (
    template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    system_prompt TEXT NOT NULL,
    mcp_requirements JSONB DEFAULT '[]'::jsonb, -- No credentials, just requirements
    agentpress_tools JSONB DEFAULT '{}'::jsonb,
    tags TEXT[] DEFAULT '{}',
    is_public BOOLEAN DEFAULT FALSE,
    marketplace_published_at TIMESTAMPTZ,
    download_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    avatar VARCHAR(10),
    avatar_color VARCHAR(7),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for agent_templates
CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_id ON agent_templates(creator_id);
CREATE INDEX IF NOT EXISTS idx_agent_templates_is_public ON agent_templates(is_public);
CREATE INDEX IF NOT EXISTS idx_agent_templates_marketplace_published_at ON agent_templates(marketplace_published_at);
CREATE INDEX IF NOT EXISTS idx_agent_templates_download_count ON agent_templates(download_count);
CREATE INDEX IF NOT EXISTS idx_agent_templates_tags ON agent_templates USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_agent_templates_created_at ON agent_templates(created_at);
CREATE INDEX IF NOT EXISTS idx_agent_templates_metadata ON agent_templates USING gin(metadata);

-- =====================================================
-- 2. USER MCP CREDENTIALS TABLE
-- =====================================================
-- Stores encrypted MCP credentials per user
CREATE TABLE IF NOT EXISTS user_mcp_credentials (
    credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    mcp_qualified_name VARCHAR(255) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    encrypted_config TEXT NOT NULL, -- Encrypted JSON config
    config_hash VARCHAR(64) NOT NULL, -- SHA-256 hash for integrity checking
    is_active BOOLEAN DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure one credential per user per MCP
    UNIQUE(account_id, mcp_qualified_name)
);

-- Indexes for user_mcp_credentials
CREATE INDEX IF NOT EXISTS idx_user_mcp_credentials_account_id ON user_mcp_credentials(account_id);
CREATE INDEX IF NOT EXISTS idx_user_mcp_credentials_mcp_name ON user_mcp_credentials(mcp_qualified_name);
CREATE INDEX IF NOT EXISTS idx_user_mcp_credentials_is_active ON user_mcp_credentials(is_active);
CREATE INDEX IF NOT EXISTS idx_user_mcp_credentials_last_used ON user_mcp_credentials(last_used_at);

-- =====================================================
-- 3. AGENT INSTANCES TABLE
-- =====================================================
-- Links templates with user credentials to create runnable agents
CREATE TABLE IF NOT EXISTS agent_instances (
    instance_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID REFERENCES agent_templates(template_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    credential_mappings JSONB DEFAULT '{}'::jsonb, -- Maps MCP qualified_name to credential_id
    custom_system_prompt TEXT, -- Optional override of template system prompt
    is_active BOOLEAN DEFAULT TRUE,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    avatar VARCHAR(10),
    avatar_color VARCHAR(7),
    
    -- For backward compatibility, allow instances without templates (existing agents)
    CONSTRAINT check_template_or_legacy CHECK (
        template_id IS NOT NULL OR 
        (template_id IS NULL AND created_at < NOW()) -- Legacy agents
    )
);

-- Indexes for agent_instances
CREATE INDEX IF NOT EXISTS idx_agent_instances_template_id ON agent_instances(template_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_account_id ON agent_instances(account_id);
CREATE INDEX IF NOT EXISTS idx_agent_instances_is_active ON agent_instances(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_instances_is_default ON agent_instances(is_default);
CREATE INDEX IF NOT EXISTS idx_agent_instances_created_at ON agent_instances(created_at);

-- Ensure only one default agent per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instances_account_default 
ON agent_instances(account_id, is_default) WHERE is_default = true;

-- =====================================================
-- 4. CREDENTIAL USAGE TRACKING
-- =====================================================
-- Track when and how credentials are used for auditing
CREATE TABLE IF NOT EXISTS credential_usage_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_id UUID NOT NULL REFERENCES user_mcp_credentials(credential_id) ON DELETE CASCADE,
    instance_id UUID REFERENCES agent_instances(instance_id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL, -- 'connect', 'tool_call', 'disconnect'
    success BOOLEAN NOT NULL,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for credential_usage_log
CREATE INDEX IF NOT EXISTS idx_credential_usage_log_credential_id ON credential_usage_log(credential_id);
CREATE INDEX IF NOT EXISTS idx_credential_usage_log_instance_id ON credential_usage_log(instance_id);
CREATE INDEX IF NOT EXISTS idx_credential_usage_log_created_at ON credential_usage_log(created_at);
CREATE INDEX IF NOT EXISTS idx_credential_usage_log_action ON credential_usage_log(action);

-- =====================================================
-- 5. UPDATE TRIGGERS
-- =====================================================
-- Update triggers for updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
DROP TRIGGER IF EXISTS trigger_agent_templates_updated_at ON agent_templates;
CREATE TRIGGER trigger_agent_templates_updated_at
    BEFORE UPDATE ON agent_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_timestamp();

DROP TRIGGER IF EXISTS trigger_user_mcp_credentials_updated_at ON user_mcp_credentials;
CREATE TRIGGER trigger_user_mcp_credentials_updated_at
    BEFORE UPDATE ON user_mcp_credentials
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_timestamp();

DROP TRIGGER IF EXISTS trigger_agent_instances_updated_at ON agent_instances;
CREATE TRIGGER trigger_agent_instances_updated_at
    BEFORE UPDATE ON agent_instances
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_timestamp();

-- =====================================================
-- 6. ROW LEVEL SECURITY POLICIES
-- =====================================================

-- Enable RLS on all new tables
ALTER TABLE agent_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_mcp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_usage_log ENABLE ROW LEVEL SECURITY;

-- Agent Templates Policies
DROP POLICY IF EXISTS agent_templates_select_policy ON agent_templates;
CREATE POLICY agent_templates_select_policy ON agent_templates
    FOR SELECT
    USING (
        is_public = true OR 
        basejump.has_role_on_account(creator_id)
    );

DROP POLICY IF EXISTS agent_templates_insert_policy ON agent_templates;
CREATE POLICY agent_templates_insert_policy ON agent_templates
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(creator_id, 'owner'));

DROP POLICY IF EXISTS agent_templates_update_policy ON agent_templates;
CREATE POLICY agent_templates_update_policy ON agent_templates
    FOR UPDATE
    USING (basejump.has_role_on_account(creator_id, 'owner'));

DROP POLICY IF EXISTS agent_templates_delete_policy ON agent_templates;
CREATE POLICY agent_templates_delete_policy ON agent_templates
    FOR DELETE
    USING (basejump.has_role_on_account(creator_id, 'owner'));

-- User MCP Credentials Policies (users can only access their own credentials)
DROP POLICY IF EXISTS user_mcp_credentials_select_policy ON user_mcp_credentials;
CREATE POLICY user_mcp_credentials_select_policy ON user_mcp_credentials
    FOR SELECT
    USING (basejump.has_role_on_account(account_id));

DROP POLICY IF EXISTS user_mcp_credentials_insert_policy ON user_mcp_credentials;
CREATE POLICY user_mcp_credentials_insert_policy ON user_mcp_credentials
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id, 'owner'));

DROP POLICY IF EXISTS user_mcp_credentials_update_policy ON user_mcp_credentials;
CREATE POLICY user_mcp_credentials_update_policy ON user_mcp_credentials
    FOR UPDATE
    USING (basejump.has_role_on_account(account_id, 'owner'));

DROP POLICY IF EXISTS user_mcp_credentials_delete_policy ON user_mcp_credentials;
CREATE POLICY user_mcp_credentials_delete_policy ON user_mcp_credentials
    FOR DELETE
    USING (basejump.has_role_on_account(account_id, 'owner'));

-- Agent Instances Policies
DROP POLICY IF EXISTS agent_instances_select_policy ON agent_instances;
CREATE POLICY agent_instances_select_policy ON agent_instances
    FOR SELECT
    USING (basejump.has_role_on_account(account_id));

DROP POLICY IF EXISTS agent_instances_insert_policy ON agent_instances;
CREATE POLICY agent_instances_insert_policy ON agent_instances
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id, 'owner'));

DROP POLICY IF EXISTS agent_instances_update_policy ON agent_instances;
CREATE POLICY agent_instances_update_policy ON agent_instances
    FOR UPDATE
    USING (basejump.has_role_on_account(account_id, 'owner'));

DROP POLICY IF EXISTS agent_instances_delete_policy ON agent_instances;
CREATE POLICY agent_instances_delete_policy ON agent_instances
    FOR DELETE
    USING (basejump.has_role_on_account(account_id, 'owner') AND is_default = false);

-- Credential Usage Log Policies
DROP POLICY IF EXISTS credential_usage_log_select_policy ON credential_usage_log;
CREATE POLICY credential_usage_log_select_policy ON credential_usage_log
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_mcp_credentials 
            WHERE user_mcp_credentials.credential_id = credential_usage_log.credential_id
            AND basejump.has_role_on_account(user_mcp_credentials.account_id)
        )
    );

DROP POLICY IF EXISTS credential_usage_log_insert_policy ON credential_usage_log;
CREATE POLICY credential_usage_log_insert_policy ON credential_usage_log
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM user_mcp_credentials 
            WHERE user_mcp_credentials.credential_id = credential_usage_log.credential_id
            AND basejump.has_role_on_account(user_mcp_credentials.account_id)
        )
    );

-- =====================================================
-- 7. HELPER FUNCTIONS
-- =====================================================

-- Function to create agent template from existing agent
CREATE OR REPLACE FUNCTION create_template_from_agent(
    p_agent_id UUID,
    p_creator_id UUID
)
RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_template_id UUID;
    v_agent agents%ROWTYPE;
    v_mcp_requirements JSONB := '[]'::jsonb;
    v_mcp_config JSONB;
BEGIN
    -- Get the agent
    SELECT * INTO v_agent FROM agents WHERE agent_id = p_agent_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent not found';
    END IF;
    
    -- Check ownership
    IF NOT basejump.has_role_on_account(v_agent.account_id, 'owner') THEN
        RAISE EXCEPTION 'Access denied';
    END IF;
    
    -- Extract MCP requirements (remove credentials)
    FOR v_mcp_config IN SELECT * FROM jsonb_array_elements(v_agent.configured_mcps)
    LOOP
        v_mcp_requirements := v_mcp_requirements || jsonb_build_object(
            'qualifiedName', v_mcp_config->>'qualifiedName',
            'name', v_mcp_config->>'name',
            'enabledTools', v_mcp_config->'enabledTools',
            'requiredConfig', (
                SELECT jsonb_agg(key) 
                FROM jsonb_object_keys(v_mcp_config->'config') AS key
            )
        );
    END LOOP;
    
    -- Create template
    INSERT INTO agent_templates (
        creator_id,
        name,
        description,
        system_prompt,
        mcp_requirements,
        agentpress_tools,
        tags,
        avatar,
        avatar_color
    ) VALUES (
        p_creator_id,
        v_agent.name,
        v_agent.description,
        v_agent.system_prompt,
        v_mcp_requirements,
        v_agent.agentpress_tools,
        v_agent.tags,
        v_agent.avatar,
        v_agent.avatar_color
    ) RETURNING template_id INTO v_template_id;
    
    RETURN v_template_id;
END;
$$;

-- Function to install template as agent instance
CREATE OR REPLACE FUNCTION install_template_as_instance(
    p_template_id UUID,
    p_account_id UUID,
    p_instance_name VARCHAR(255) DEFAULT NULL
)
RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_instance_id UUID;
    v_template agent_templates%ROWTYPE;
    v_instance_name VARCHAR(255);
    v_credential_mappings JSONB := '{}'::jsonb;
    v_mcp_req JSONB;
    v_credential_id UUID;
BEGIN
    -- Get template
    SELECT * INTO v_template FROM agent_templates WHERE template_id = p_template_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Template not found';
    END IF;
    
    -- Check if template is public or user owns it
    IF NOT (v_template.is_public OR basejump.has_role_on_account(v_template.creator_id)) THEN
        RAISE EXCEPTION 'Access denied to template';
    END IF;
    
    -- Set instance name
    v_instance_name := COALESCE(p_instance_name, v_template.name || ' (from marketplace)');
    
    -- Build credential mappings
    FOR v_mcp_req IN SELECT * FROM jsonb_array_elements(v_template.mcp_requirements)
    LOOP
        -- Find user's credential for this MCP
        SELECT credential_id INTO v_credential_id
        FROM user_mcp_credentials
        WHERE account_id = p_account_id 
        AND mcp_qualified_name = (v_mcp_req->>'qualifiedName')
        AND is_active = true;
        
        IF v_credential_id IS NOT NULL THEN
            v_credential_mappings := v_credential_mappings || 
                jsonb_build_object(v_mcp_req->>'qualifiedName', v_credential_id);
        END IF;
    END LOOP;
    
    -- Create agent instance
    INSERT INTO agent_instances (
        template_id,
        account_id,
        name,
        description,
        credential_mappings,
        avatar,
        avatar_color
    ) VALUES (
        p_template_id,
        p_account_id,
        v_instance_name,
        v_template.description,
        v_credential_mappings,
        v_template.avatar,
        v_template.avatar_color
    ) RETURNING instance_id INTO v_instance_id;
    
    -- Update template download count
    UPDATE agent_templates 
    SET download_count = download_count + 1 
    WHERE template_id = p_template_id;
    
    RETURN v_instance_id;
END;
$$;

-- Function to get missing credentials for template
CREATE OR REPLACE FUNCTION get_missing_credentials_for_template(
    p_template_id UUID,
    p_account_id UUID
)
RETURNS TABLE (
    qualified_name VARCHAR(255),
    display_name VARCHAR(255),
    required_config TEXT[]
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        (mcp_req->>'qualifiedName')::VARCHAR(255) as qualified_name,
        (mcp_req->>'name')::VARCHAR(255) as display_name,
        ARRAY(SELECT jsonb_array_elements_text(mcp_req->'requiredConfig')) as required_config
    FROM agent_templates t,
         jsonb_array_elements(t.mcp_requirements) as mcp_req
    WHERE t.template_id = p_template_id
    AND NOT EXISTS (
        SELECT 1 FROM user_mcp_credentials c
        WHERE c.account_id = p_account_id
        AND c.mcp_qualified_name = (mcp_req->>'qualifiedName')
        AND c.is_active = true
    );
END;
$$;

GRANT EXECUTE ON FUNCTION create_template_from_agent(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION install_template_as_instance(UUID, UUID, VARCHAR) TO authenticated;
GRANT EXECUTE ON FUNCTION get_missing_credentials_for_template(UUID, UUID) TO authenticated;

GRANT ALL PRIVILEGES ON TABLE agent_templates TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE user_mcp_credentials TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE agent_instances TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE credential_usage_log TO authenticated, service_role;

COMMIT; 