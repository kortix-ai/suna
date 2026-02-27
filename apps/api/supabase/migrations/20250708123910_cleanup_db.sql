BEGIN;

DROP TABLE IF EXISTS workflow_flows CASCADE;
DROP TABLE IF EXISTS workflow_execution_logs CASCADE;
DROP TABLE IF EXISTS workflow_variables CASCADE;
DROP TABLE IF EXISTS webhook_registrations CASCADE;
DROP TABLE IF EXISTS scheduled_jobs CASCADE;
DROP TABLE IF EXISTS triggers CASCADE;
DROP TABLE IF EXISTS agent_instances CASCADE;
DROP TABLE IF EXISTS oauth_installations CASCADE;
DROP TABLE IF EXISTS credential_usage_log CASCADE;
DROP TABLE IF EXISTS user_agent_library CASCADE;

DROP TABLE IF EXISTS workflow_templates CASCADE;
DROP TABLE IF EXISTS workflows CASCADE;

DROP TYPE IF EXISTS connection_type CASCADE;
DROP TYPE IF EXISTS node_type CASCADE;
DROP TYPE IF EXISTS trigger_type CASCADE;
DROP TYPE IF EXISTS execution_status CASCADE;
DROP TYPE IF EXISTS workflow_status CASCADE;

DROP TABLE IF EXISTS user_mcp_credentials CASCADE;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

UPDATE agents 
SET config = jsonb_build_object(
    'system_prompt', COALESCE(system_prompt, ''),
    'tools', jsonb_build_object(
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
    ),
    'metadata', jsonb_build_object(
        'avatar', avatar,
        'avatar_color', avatar_color
    )
)
WHERE config = '{}'::jsonb OR config IS NULL;

ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

UPDATE agent_versions 
SET config = jsonb_build_object(
    'system_prompt', COALESCE(system_prompt, ''),
    'tools', jsonb_build_object(
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
)
WHERE config = '{}'::jsonb OR config IS NULL;

ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS change_description TEXT;
ALTER TABLE agent_versions ADD COLUMN IF NOT EXISTS previous_version_id UUID REFERENCES agent_versions(version_id);

DROP TABLE IF EXISTS agent_version_history CASCADE;

ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS execution_type VARCHAR(50) DEFAULT 'agent' CHECK (execution_type IN ('agent', 'workflow'));
ALTER TABLE agent_triggers ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES agent_workflows(id) ON DELETE SET NULL;

ALTER TABLE trigger_events ADD COLUMN IF NOT EXISTS workflow_execution_id UUID REFERENCES workflow_executions(id) ON DELETE SET NULL;

COMMENT ON COLUMN agents.system_prompt IS 'DEPRECATED: Use config->>system_prompt instead';
COMMENT ON COLUMN agents.configured_mcps IS 'DEPRECATED: Use config->>tools->>mcp instead';
COMMENT ON COLUMN agents.agentpress_tools IS 'DEPRECATED: Use config->>tools->>agentpress instead';
COMMENT ON COLUMN agents.custom_mcps IS 'DEPRECATED: Use config->>tools->>custom_mcp instead';
COMMENT ON COLUMN agents.avatar IS 'DEPRECATED: Use config->>metadata->>avatar instead';
COMMENT ON COLUMN agents.avatar_color IS 'DEPRECATED: Use config->>metadata->>avatar_color instead';

COMMENT ON COLUMN agent_versions.system_prompt IS 'DEPRECATED: Use config->>system_prompt instead';
COMMENT ON COLUMN agent_versions.configured_mcps IS 'DEPRECATED: Use config->>tools->>mcp instead';
COMMENT ON COLUMN agent_versions.agentpress_tools IS 'DEPRECATED: Use config->>tools->>agentpress instead';
COMMENT ON COLUMN agent_versions.custom_mcps IS 'DEPRECATED: Use config->>tools->>custom_mcp instead';

CREATE OR REPLACE FUNCTION get_agent_config(p_agent_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_agent RECORD;
    v_config JSONB;
BEGIN
    SELECT * INTO v_agent FROM agents WHERE agent_id = p_agent_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    IF v_agent.config IS NOT NULL AND v_agent.config != '{}'::jsonb THEN
        RETURN v_agent.config;
    END IF;
    
    v_config := jsonb_build_object(
        'system_prompt', COALESCE(v_agent.system_prompt, ''),
        'tools', jsonb_build_object(
            'agentpress', (
                SELECT jsonb_object_agg(
                    key, 
                    (value->>'enabled')::boolean
                )
                FROM jsonb_each(COALESCE(v_agent.agentpress_tools, '{}'::jsonb))
                WHERE value IS NOT NULL AND value != 'null'::jsonb
            ),
            'mcp', COALESCE(v_agent.configured_mcps, '[]'::jsonb),
            'custom_mcp', COALESCE(v_agent.custom_mcps, '[]'::jsonb)
        ),
        'metadata', jsonb_build_object(
            'avatar', v_agent.avatar,
            'avatar_color', v_agent.avatar_color
        )
    );
    
    RETURN v_config;
END;
$$;

GRANT EXECUTE ON FUNCTION get_agent_config(UUID) TO authenticated, service_role;

COMMENT ON TABLE agent_workflows IS 'Agent workflows - step-by-step task execution';
COMMENT ON TABLE workflow_steps IS 'Individual steps within an agent workflow';
COMMENT ON TABLE workflow_executions IS 'Execution history of agent workflows';
COMMENT ON TABLE workflow_step_executions IS 'Detailed execution logs for each workflow step';

COMMENT ON COLUMN agents.config IS 'Unified configuration object containing all agent settings';
COMMENT ON COLUMN agent_versions.config IS 'Versioned configuration snapshot';

COMMENT ON COLUMN agents.is_default IS 'Whether this agent is the default for the account (only one allowed per account)';
COMMENT ON COLUMN agent_triggers.execution_type IS 'Whether trigger executes an agent conversation or a workflow';

COMMIT; 