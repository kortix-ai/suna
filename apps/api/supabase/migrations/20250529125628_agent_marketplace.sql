BEGIN;

-- Add marketplace fields to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS marketplace_published_at TIMESTAMPTZ;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS download_count INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_agents_is_public ON agents(is_public);
CREATE INDEX IF NOT EXISTS idx_agents_marketplace_published_at ON agents(marketplace_published_at);
CREATE INDEX IF NOT EXISTS idx_agents_download_count ON agents(download_count);
CREATE INDEX IF NOT EXISTS idx_agents_tags ON agents USING gin(tags);

CREATE TABLE IF NOT EXISTS user_agent_library (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    original_agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ DEFAULT NOW(),
    is_favorite BOOLEAN DEFAULT false,
    
    UNIQUE(user_account_id, original_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_user_agent_library_user_account ON user_agent_library(user_account_id);
CREATE INDEX IF NOT EXISTS idx_user_agent_library_original_agent ON user_agent_library(original_agent_id);
CREATE INDEX IF NOT EXISTS idx_user_agent_library_agent_id ON user_agent_library(agent_id);
CREATE INDEX IF NOT EXISTS idx_user_agent_library_added_at ON user_agent_library(added_at);

ALTER TABLE user_agent_library ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_agent_library_select_own ON user_agent_library;
DROP POLICY IF EXISTS user_agent_library_insert_own ON user_agent_library;
DROP POLICY IF EXISTS user_agent_library_update_own ON user_agent_library;
DROP POLICY IF EXISTS user_agent_library_delete_own ON user_agent_library;

CREATE POLICY user_agent_library_select_own ON user_agent_library
    FOR SELECT
    USING (basejump.has_role_on_account(user_account_id));

CREATE POLICY user_agent_library_insert_own ON user_agent_library
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(user_account_id));

CREATE POLICY user_agent_library_update_own ON user_agent_library
    FOR UPDATE
    USING (basejump.has_role_on_account(user_account_id));

CREATE POLICY user_agent_library_delete_own ON user_agent_library
    FOR DELETE
    USING (basejump.has_role_on_account(user_account_id));

DROP POLICY IF EXISTS agents_select_marketplace ON agents;
CREATE POLICY agents_select_marketplace ON agents
    FOR SELECT
    USING (
        is_public = true OR
        basejump.has_role_on_account(account_id)
    );

CREATE OR REPLACE FUNCTION publish_agent_to_marketplace(p_agent_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM agents 
        WHERE agent_id = p_agent_id 
        AND basejump.has_role_on_account(account_id, 'owner')
    ) THEN
        RAISE EXCEPTION 'Agent not found or access denied';
    END IF;
    
    UPDATE agents 
    SET 
        is_public = true,
        marketplace_published_at = NOW()
    WHERE agent_id = p_agent_id;
END;
$$;

CREATE OR REPLACE FUNCTION unpublish_agent_from_marketplace(p_agent_id UUID)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM agents 
        WHERE agent_id = p_agent_id 
        AND basejump.has_role_on_account(account_id, 'owner')
    ) THEN
        RAISE EXCEPTION 'Agent not found or access denied';
    END IF;
    
    UPDATE agents 
    SET 
        is_public = false,
        marketplace_published_at = NULL
    WHERE agent_id = p_agent_id;
END;
$$;

-- Drop existing functions to avoid conflicts
DROP FUNCTION IF EXISTS add_agent_to_library(UUID);
DROP FUNCTION IF EXISTS add_agent_to_library(UUID, UUID);

CREATE OR REPLACE FUNCTION add_agent_to_library(
    p_original_agent_id UUID,
    p_user_account_id UUID
)
RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_agent_id UUID;
    v_original_agent agents%ROWTYPE;
BEGIN
    SELECT * INTO v_original_agent
    FROM agents 
    WHERE agent_id = p_original_agent_id AND is_public = true;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Agent not found or not public';
    END IF;
    
    IF EXISTS (
        SELECT 1 FROM user_agent_library 
        WHERE user_account_id = p_user_account_id 
        AND original_agent_id = p_original_agent_id
    ) THEN
        RAISE EXCEPTION 'Agent already in your library';
    END IF;
    
    INSERT INTO agents (
        account_id,
        name,
        description,
        system_prompt,
        configured_mcps,
        agentpress_tools,
        is_default,
        is_public,
        tags,
        avatar,
        avatar_color
    ) VALUES (
        p_user_account_id,
        v_original_agent.name || ' (from marketplace)',
        v_original_agent.description,
        v_original_agent.system_prompt,
        v_original_agent.configured_mcps,
        v_original_agent.agentpress_tools,
        false,
        false,
        v_original_agent.tags,
        v_original_agent.avatar,
        v_original_agent.avatar_color
    ) RETURNING agent_id INTO v_new_agent_id;
    
    INSERT INTO user_agent_library (
        user_account_id,
        original_agent_id,
        agent_id
    ) VALUES (
        p_user_account_id,
        p_original_agent_id,
        v_new_agent_id
    );
    
    UPDATE agents 
    SET download_count = download_count + 1 
    WHERE agent_id = p_original_agent_id;
    
    RETURN v_new_agent_id;
END;
$$;

-- Drop existing function to avoid type conflicts
DROP FUNCTION IF EXISTS get_marketplace_agents(INTEGER, INTEGER, TEXT, TEXT[]);

CREATE OR REPLACE FUNCTION get_marketplace_agents(
    p_limit INTEGER DEFAULT 50,
    p_offset INTEGER DEFAULT 0,
    p_search TEXT DEFAULT NULL,
    p_tags TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    agent_id UUID,
    name VARCHAR(255),
    description TEXT,
    system_prompt TEXT,
    configured_mcps JSONB,
    agentpress_tools JSONB,
    tags TEXT[],
    download_count INTEGER,
    marketplace_published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    creator_name TEXT,
    avatar TEXT,
    avatar_color TEXT
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.agent_id,
        a.name,
        a.description,
        a.system_prompt,
        a.configured_mcps,
        a.agentpress_tools,
        a.tags,
        a.download_count,
        a.marketplace_published_at,
        a.created_at,
        COALESCE(acc.name, 'Anonymous')::TEXT as creator_name,
        a.avatar::TEXT,
        a.avatar_color::TEXT
    FROM agents a
    LEFT JOIN basejump.accounts acc ON a.account_id = acc.id
    WHERE a.is_public = true
    AND (p_search IS NULL OR 
         a.name ILIKE '%' || p_search || '%' OR 
         a.description ILIKE '%' || p_search || '%')
    AND (p_tags IS NULL OR a.tags && p_tags)
    ORDER BY a.marketplace_published_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION publish_agent_to_marketplace TO authenticated;
GRANT EXECUTE ON FUNCTION unpublish_agent_from_marketplace TO authenticated;
GRANT EXECUTE ON FUNCTION add_agent_to_library(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_marketplace_agents(INTEGER, INTEGER, TEXT, TEXT[]) TO authenticated, anon;
GRANT ALL PRIVILEGES ON TABLE user_agent_library TO authenticated, service_role;

COMMIT; 