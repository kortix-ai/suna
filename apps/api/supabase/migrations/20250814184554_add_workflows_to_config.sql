BEGIN;

CREATE OR REPLACE FUNCTION update_version_config_with_workflows(p_version_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_agent_id UUID;
    v_config JSONB;
    v_workflows JSONB;
BEGIN
    SELECT agent_id, config INTO v_agent_id, v_config
    FROM agent_versions
    WHERE version_id = p_version_id;
    
    IF v_config IS NULL THEN
        RETURN;
    END IF;
    
    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'id', id,
                'name', name,
                'description', description,
                'status', status,
                'trigger_phrase', trigger_phrase,
                'is_default', is_default,
                'steps', steps,
                'created_at', created_at,
                'updated_at', updated_at
            ) ORDER BY created_at DESC
        ),
        '[]'::jsonb
    ) INTO v_workflows
    FROM agent_workflows
    WHERE agent_id = v_agent_id;
    
    v_config = jsonb_set(v_config, '{workflows}', v_workflows);
    
    UPDATE agent_versions
    SET config = v_config
    WHERE version_id = p_version_id;
    
END;
$$;

DO $$
DECLARE
    v_version RECORD;
    v_count INTEGER := 0;
    v_total INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total FROM agent_versions WHERE config IS NOT NULL;
    
    RAISE NOTICE 'Starting to update % version configs with workflows', v_total;
    
    FOR v_version IN 
        SELECT version_id 
        FROM agent_versions 
        WHERE config IS NOT NULL
        AND (config->>'workflows') IS NULL
    LOOP
        PERFORM update_version_config_with_workflows(v_version.version_id);
        v_count := v_count + 1;
        
        IF v_count % 100 = 0 THEN
            RAISE NOTICE 'Processed % of % versions', v_count, v_total;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Completed updating % version configs with workflows', v_count;
END;
$$;

DROP FUNCTION IF EXISTS update_version_config_with_workflows(UUID);

COMMENT ON COLUMN agent_versions.config IS 'Unified configuration including system_prompt, tools, workflows, and metadata';

COMMIT; 