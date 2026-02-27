BEGIN;

-- Create RPC function to find Suna default agent for an account
CREATE OR REPLACE FUNCTION find_suna_default_agent_for_account(p_account_id UUID)
RETURNS TABLE (
    agent_id UUID,
    account_id UUID,
    name VARCHAR(255),
    description TEXT,
    system_prompt TEXT,
    configured_mcps JSONB,
    custom_mcps JSONB,
    agentpress_tools JSONB,
    is_default BOOLEAN,
    avatar VARCHAR(10),
    avatar_color VARCHAR(7),
    metadata JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    is_active BOOLEAN,
    is_public BOOLEAN,
    marketplace_published_at TIMESTAMPTZ,
    download_count INTEGER,
    tags TEXT[],
    current_version_id UUID,
    version_count INTEGER
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.agent_id,
        a.account_id,
        a.name,
        a.description,
        a.system_prompt,
        a.configured_mcps,
        a.custom_mcps,
        a.agentpress_tools,
        a.is_default,
        a.avatar,
        a.avatar_color,
        a.metadata,
        a.created_at,
        a.updated_at,
        true as is_active,
        COALESCE(a.is_public, false) as is_public,
        a.marketplace_published_at,
        COALESCE(a.download_count, 0) as download_count,
        COALESCE(a.tags, '{}') as tags,
        a.current_version_id,
        COALESCE(a.version_count, 1) as version_count
    FROM agents a
    WHERE a.account_id = p_account_id 
    AND COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
    ORDER BY a.created_at DESC
    LIMIT 1;
END;
$$;

-- Create function to get all Suna default agents
CREATE OR REPLACE FUNCTION get_all_suna_default_agents()
RETURNS TABLE (
    agent_id UUID,
    account_id UUID,
    name VARCHAR(255),
    description TEXT,
    system_prompt TEXT,
    configured_mcps JSONB,
    custom_mcps JSONB,
    agentpress_tools JSONB,
    is_default BOOLEAN,
    avatar VARCHAR(10),
    avatar_color VARCHAR(7),
    metadata JSONB,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    is_active BOOLEAN,
    management_version TEXT,
    centrally_managed BOOLEAN
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.agent_id,
        a.account_id,
        a.name,
        a.description,
        a.system_prompt,
        a.configured_mcps,
        a.custom_mcps,
        a.agentpress_tools,
        a.is_default,
        a.avatar,
        a.avatar_color,
        a.metadata,
        a.created_at,
        a.updated_at,
        true as is_active,
        a.metadata->>'management_version' as management_version,
        COALESCE((a.metadata->>'centrally_managed')::boolean, false) as centrally_managed
    FROM agents a
    WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
    ORDER BY a.created_at DESC;
END;
$$;

-- Create function to count agents by management version
CREATE OR REPLACE FUNCTION count_suna_agents_by_version(p_version TEXT)
RETURNS INTEGER
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    agent_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO agent_count
    FROM agents a
    WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
    AND a.metadata->>'management_version' = p_version;
    
    RETURN COALESCE(agent_count, 0);
END;
$$;

-- Create function to get Suna default agent statistics
CREATE OR REPLACE FUNCTION get_suna_default_agent_stats()
RETURNS TABLE (
    total_agents INTEGER,
    active_agents INTEGER,
    inactive_agents INTEGER,
    version_distribution JSONB,
    creation_dates JSONB
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    total_count INTEGER;
    active_count INTEGER;
    inactive_count INTEGER;
    version_stats JSONB;
    creation_stats JSONB;
BEGIN
    -- Get total count
    SELECT COUNT(*) INTO total_count
    FROM agents a
    WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true;
    
    -- Get active count (all Suna agents are considered active)
    SELECT COUNT(*) INTO active_count
    FROM agents a
    WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true;
    
    -- Calculate inactive count
    inactive_count := total_count - active_count;
    
    -- Get version distribution
    SELECT jsonb_object_agg(
        COALESCE(a.metadata->>'management_version', 'unknown'),
        version_count
    ) INTO version_stats
    FROM (
        SELECT 
            COALESCE(a.metadata->>'management_version', 'unknown') as version,
            COUNT(*) as version_count
        FROM agents a
        WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
        GROUP BY COALESCE(a.metadata->>'management_version', 'unknown')
    ) version_data;
    
    -- Get creation date distribution (by month)
    SELECT jsonb_object_agg(
        creation_month,
        month_count
    ) INTO creation_stats
    FROM (
        SELECT 
            TO_CHAR(a.created_at, 'YYYY-MM') as creation_month,
            COUNT(*) as month_count
        FROM agents a
        WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
        GROUP BY TO_CHAR(a.created_at, 'YYYY-MM')
        ORDER BY creation_month DESC
        LIMIT 12  -- Last 12 months
    ) creation_data;
    
    RETURN QUERY
    SELECT 
        total_count,
        active_count,
        inactive_count,
        COALESCE(version_stats, '{}'::jsonb),
        COALESCE(creation_stats, '{}'::jsonb);
END;
$$;

-- Create function to find agents needing updates to a specific version
CREATE OR REPLACE FUNCTION find_suna_agents_needing_update(p_target_version TEXT)
RETURNS TABLE (
    agent_id UUID,
    account_id UUID,
    name VARCHAR(255),
    current_version TEXT,
    last_central_update TIMESTAMPTZ
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        a.agent_id,
        a.account_id,
        a.name,
        COALESCE(a.metadata->>'management_version', 'unknown') as current_version,
        (a.metadata->>'last_central_update')::timestamptz as last_central_update
    FROM agents a
    WHERE COALESCE((a.metadata->>'is_suna_default')::boolean, false) = true
    AND COALESCE((a.metadata->>'centrally_managed')::boolean, false) = true
    AND (
        a.metadata->>'management_version' IS NULL 
        OR a.metadata->>'management_version' != p_target_version
    )
    ORDER BY a.created_at ASC;
END;
$$;

-- Grant permissions to the functions
GRANT EXECUTE ON FUNCTION find_suna_default_agent_for_account(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_all_suna_default_agents() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION count_suna_agents_by_version(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_suna_default_agent_stats() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION find_suna_agents_needing_update(TEXT) TO authenticated, service_role;

COMMIT; 