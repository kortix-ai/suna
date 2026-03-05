BEGIN;

CREATE TABLE IF NOT EXISTS agent_versions (
    version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    version_name VARCHAR(50) NOT NULL,
    system_prompt TEXT NOT NULL,
    configured_mcps JSONB DEFAULT '[]'::jsonb,
    custom_mcps JSONB DEFAULT '[]'::jsonb,
    agentpress_tools JSONB DEFAULT '{}'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_by UUID REFERENCES basejump.accounts(id),
    
    UNIQUE(agent_id, version_number),
    UNIQUE(agent_id, version_name)
);

-- Indexes for agent_versions
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id ON agent_versions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_versions_version_number ON agent_versions(version_number);
CREATE INDEX IF NOT EXISTS idx_agent_versions_is_active ON agent_versions(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_versions_created_at ON agent_versions(created_at);

-- Add current version tracking to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS current_version_id UUID REFERENCES agent_versions(version_id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS version_count INTEGER DEFAULT 1;

-- Add index for current version
CREATE INDEX IF NOT EXISTS idx_agents_current_version ON agents(current_version_id);

-- Add version tracking to threads (which version is being used in this thread)
ALTER TABLE threads ADD COLUMN IF NOT EXISTS agent_version_id UUID REFERENCES agent_versions(version_id);

-- Add index for thread version
CREATE INDEX IF NOT EXISTS idx_threads_agent_version ON threads(agent_version_id);

-- Track version changes and history
CREATE TABLE IF NOT EXISTS agent_version_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    version_id UUID NOT NULL REFERENCES agent_versions(version_id) ON DELETE CASCADE,
    action VARCHAR(50) NOT NULL, -- 'created', 'updated', 'activated', 'deactivated'
    changed_by UUID REFERENCES basejump.accounts(id),
    change_description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for version history
CREATE INDEX IF NOT EXISTS idx_agent_version_history_agent_id ON agent_version_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_version_history_version_id ON agent_version_history(version_id);
CREATE INDEX IF NOT EXISTS idx_agent_version_history_created_at ON agent_version_history(created_at);

-- Update updated_at timestamp for agent_versions
CREATE OR REPLACE FUNCTION update_agent_versions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if it exists, then create it
DROP TRIGGER IF EXISTS trigger_agent_versions_updated_at ON agent_versions;
CREATE TRIGGER trigger_agent_versions_updated_at
    BEFORE UPDATE ON agent_versions
    FOR EACH ROW
    EXECUTE FUNCTION update_agent_versions_updated_at();

-- Enable RLS on new tables
ALTER TABLE agent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_version_history ENABLE ROW LEVEL SECURITY;

-- Policies for agent_versions
DROP POLICY IF EXISTS agent_versions_select_policy ON agent_versions;
CREATE POLICY agent_versions_select_policy ON agent_versions
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_versions.agent_id
            AND basejump.has_role_on_account(agents.account_id)
        )
    );

DROP POLICY IF EXISTS agent_versions_insert_policy ON agent_versions;
CREATE POLICY agent_versions_insert_policy ON agent_versions
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_versions.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

DROP POLICY IF EXISTS agent_versions_update_policy ON agent_versions;
CREATE POLICY agent_versions_update_policy ON agent_versions
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_versions.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

DROP POLICY IF EXISTS agent_versions_delete_policy ON agent_versions;
CREATE POLICY agent_versions_delete_policy ON agent_versions
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_versions.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

-- Policies for agent_version_history
DROP POLICY IF EXISTS agent_version_history_select_policy ON agent_version_history;
CREATE POLICY agent_version_history_select_policy ON agent_version_history
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_version_history.agent_id
            AND basejump.has_role_on_account(agents.account_id)
        )
    );

DROP POLICY IF EXISTS agent_version_history_insert_policy ON agent_version_history;
CREATE POLICY agent_version_history_insert_policy ON agent_version_history
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_version_history.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

-- Function to migrate existing agents to versioned system
CREATE OR REPLACE FUNCTION migrate_agents_to_versioned()
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_agent RECORD;
    v_version_id UUID;
BEGIN
    -- For each existing agent, create a v1 version
    FOR v_agent IN SELECT * FROM agents WHERE current_version_id IS NULL
    LOOP
        -- Create v1 version with current agent data
        INSERT INTO agent_versions (
            agent_id,
            version_number,
            version_name,
            system_prompt,
            configured_mcps,
            custom_mcps,
            agentpress_tools,
            is_active,
            created_by
        ) VALUES (
            v_agent.agent_id,
            1,
            'v1',
            v_agent.system_prompt,
            v_agent.configured_mcps,
            '[]'::jsonb, -- agents table doesn't have custom_mcps column
            v_agent.agentpress_tools,
            TRUE,
            v_agent.account_id
        ) RETURNING version_id INTO v_version_id;
        
        -- Update agent with current version
        UPDATE agents 
        SET current_version_id = v_version_id,
            version_count = 1
        WHERE agent_id = v_agent.agent_id;
        
        -- Add history entry
        INSERT INTO agent_version_history (
            agent_id,
            version_id,
            action,
            changed_by,
            change_description
        ) VALUES (
            v_agent.agent_id,
            v_version_id,
            'created',
            v_agent.account_id,
            'Initial version created from existing agent'
        );
    END LOOP;
END;
$$;

-- Function to create a new version of an agent
CREATE OR REPLACE FUNCTION create_agent_version(
    p_agent_id UUID,
    p_system_prompt TEXT,
    p_configured_mcps JSONB DEFAULT '[]'::jsonb,
    p_custom_mcps JSONB DEFAULT '[]'::jsonb,
    p_agentpress_tools JSONB DEFAULT '{}'::jsonb,
    p_created_by UUID DEFAULT NULL
)
RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_version_id UUID;
    v_version_number INTEGER;
    v_version_name VARCHAR(50);
BEGIN
    -- Check if user has permission
    IF NOT EXISTS (
        SELECT 1 FROM agents 
        WHERE agent_id = p_agent_id 
        AND basejump.has_role_on_account(account_id, 'owner')
    ) THEN
        RAISE EXCEPTION 'Agent not found or access denied';
    END IF;
    
    -- Get next version number
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
    FROM agent_versions
    WHERE agent_id = p_agent_id;
    
    -- Generate version name
    v_version_name := 'v' || v_version_number;
    
    -- Create new version
    INSERT INTO agent_versions (
        agent_id,
        version_number,
        version_name,
        system_prompt,
        configured_mcps,
        custom_mcps,
        agentpress_tools,
        is_active,
        created_by
    ) VALUES (
        p_agent_id,
        v_version_number,
        v_version_name,
        p_system_prompt,
        p_configured_mcps,
        p_custom_mcps,
        p_agentpress_tools,
        TRUE,
        p_created_by
    ) RETURNING version_id INTO v_version_id;
    
    -- Update agent version count
    UPDATE agents 
    SET version_count = v_version_number,
        current_version_id = v_version_id
    WHERE agent_id = p_agent_id;
    
    -- Add history entry
    INSERT INTO agent_version_history (
        agent_id,
        version_id,
        action,
        changed_by,
        change_description
    ) VALUES (
        p_agent_id,
        v_version_id,
        'created',
        p_created_by,
        'New version ' || v_version_name || ' created'
    );
    
    RETURN v_version_id;
END;
$$;

-- Function to switch agent to a different version
CREATE OR REPLACE FUNCTION switch_agent_version(
    p_agent_id UUID,
    p_version_id UUID,
    p_changed_by UUID DEFAULT NULL
)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Check if user has permission and version exists
    IF NOT EXISTS (
        SELECT 1 FROM agents a
        JOIN agent_versions av ON a.agent_id = av.agent_id
        WHERE a.agent_id = p_agent_id 
        AND av.version_id = p_version_id
        AND basejump.has_role_on_account(a.account_id, 'owner')
    ) THEN
        RAISE EXCEPTION 'Agent/version not found or access denied';
    END IF;
    
    -- Update current version
    UPDATE agents 
    SET current_version_id = p_version_id
    WHERE agent_id = p_agent_id;
    
    -- Add history entry
    INSERT INTO agent_version_history (
        agent_id,
        version_id,
        action,
        changed_by,
        change_description
    ) VALUES (
        p_agent_id,
        p_version_id,
        'activated',
        p_changed_by,
        'Switched to this version'
    );
END;
$$;

-- =====================================================
-- 9. RUN MIGRATION
-- =====================================================
-- Migrate existing agents to versioned system
SELECT migrate_agents_to_versioned();

COMMIT; 