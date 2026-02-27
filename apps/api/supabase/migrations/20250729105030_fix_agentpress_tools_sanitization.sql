CREATE OR REPLACE FUNCTION sanitize_config_for_template(input_config JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    sanitized_config JSONB;
    custom_mcp_array JSONB;
    custom_mcp_item JSONB;
    sanitized_mcp JSONB;
    result_array JSONB := '[]'::jsonb;
    agentpress_tools JSONB := '{}'::jsonb;
    tool_name TEXT;
    tool_config JSONB;
BEGIN
    IF input_config->'tools'->'agentpress' IS NOT NULL THEN
        FOR tool_name IN SELECT jsonb_object_keys(input_config->'tools'->'agentpress')
        LOOP
            tool_config := input_config->'tools'->'agentpress'->tool_name;
            
            IF jsonb_typeof(tool_config) = 'boolean' THEN
                agentpress_tools := jsonb_set(agentpress_tools, ARRAY[tool_name], tool_config);
            ELSIF jsonb_typeof(tool_config) = 'object' AND tool_config ? 'enabled' THEN
                agentpress_tools := jsonb_set(agentpress_tools, ARRAY[tool_name], tool_config->'enabled');
            ELSE
                agentpress_tools := jsonb_set(agentpress_tools, ARRAY[tool_name], 'false'::jsonb);
            END IF;
        END LOOP;
    END IF;

    sanitized_config := jsonb_build_object(
        'system_prompt', COALESCE(input_config->>'system_prompt', ''),
        'tools', jsonb_build_object(
            'agentpress', agentpress_tools,
            'mcp', COALESCE(input_config->'tools'->'mcp', '[]'::jsonb),
            'custom_mcp', '[]'::jsonb
        ),
        'metadata', jsonb_build_object(
            'avatar', input_config->'metadata'->>'avatar',
            'avatar_color', input_config->'metadata'->>'avatar_color'
        )
    );
    
    custom_mcp_array := COALESCE(input_config->'tools'->'custom_mcp', '[]'::jsonb);
    
    FOR custom_mcp_item IN SELECT jsonb_array_elements(custom_mcp_array)
    LOOP
        sanitized_mcp := jsonb_build_object(
            'name', custom_mcp_item->>'name',
            'type', custom_mcp_item->>'type',
            'display_name', COALESCE(custom_mcp_item->>'display_name', custom_mcp_item->>'name'),
            'enabledTools', COALESCE(custom_mcp_item->'enabledTools', '[]'::jsonb)
        );
        
        IF custom_mcp_item->>'type' = 'pipedream' THEN
            sanitized_mcp := jsonb_set(
                sanitized_mcp,
                '{config}',
                jsonb_build_object(
                    'url', custom_mcp_item->'config'->>'url',
                    'headers', COALESCE(custom_mcp_item->'config'->'headers', '{}'::jsonb) - 'profile_id'
                )
            );
        ELSE
            sanitized_mcp := jsonb_set(sanitized_mcp, '{config}', '{}'::jsonb);
        END IF;
        
        result_array := result_array || sanitized_mcp;
    END LOOP;
    
    sanitized_config := jsonb_set(
        sanitized_config,
        '{tools,custom_mcp}',
        result_array
    );
    
    RETURN sanitized_config;
END;
$$; 