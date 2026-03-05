CREATE OR REPLACE FUNCTION get_agent_mcp_config(p_agent_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'custom_mcp', COALESCE(av.config->'tools'->'custom_mcp', '[]'::jsonb),
        'configured_mcps', COALESCE(av.config->'tools'->'mcp', '[]'::jsonb)
    ) INTO result
    FROM agents a
    JOIN agent_versions av ON av.version_id = a.current_version_id AND av.agent_id = a.agent_id
    WHERE a.agent_id = p_agent_id;
    
    RETURN COALESCE(result, jsonb_build_object('custom_mcp', '[]'::jsonb, 'configured_mcps', '[]'::jsonb));
END;
$$;

GRANT EXECUTE ON FUNCTION get_agent_mcp_config(UUID) TO authenticated, service_role;
