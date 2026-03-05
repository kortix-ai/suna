CREATE OR REPLACE FUNCTION fix_pipedream_qualified_names(config_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    updated_config JSONB := config_data;
    custom_mcps JSONB;
    mcp_item JSONB;
    fixed_mcps JSONB := '[]'::jsonb;
    app_slug TEXT;
BEGIN
    custom_mcps := config_data->'tools'->'custom_mcp';
    
    IF custom_mcps IS NOT NULL AND jsonb_typeof(custom_mcps) = 'array' THEN
        FOR mcp_item IN SELECT jsonb_array_elements(custom_mcps)
        LOOP
            IF mcp_item->>'type' = 'pipedream' THEN
                app_slug := mcp_item->'config'->'headers'->>'x-pd-app-slug';
                
                IF app_slug IS NOT NULL AND app_slug != '' THEN
                    mcp_item := jsonb_set(mcp_item, '{name}', to_jsonb(app_slug));
                END IF;
            END IF;
            
            fixed_mcps := fixed_mcps || mcp_item;
        END LOOP;
        
        updated_config := jsonb_set(updated_config, '{tools,custom_mcp}', fixed_mcps);
    END IF;
    
    RETURN updated_config;
END;
$$;

UPDATE agent_templates 
SET config = fix_pipedream_qualified_names(config)
WHERE config->'tools'->'custom_mcp' @> '[{"type": "pipedream"}]';

DROP FUNCTION fix_pipedream_qualified_names(JSONB); 