BEGIN;

-- Add steps column to agent_workflows table as flexible JSON
ALTER TABLE agent_workflows ADD COLUMN IF NOT EXISTS steps JSONB DEFAULT NULL;

-- Create index for steps column (GIN index for flexible JSON queries)
CREATE INDEX IF NOT EXISTS idx_agent_workflows_steps ON agent_workflows USING gin(steps);

UPDATE agent_workflows 
SET steps = (
    SELECT COALESCE(
        jsonb_agg(
            json_build_object(
                'id', ws.id,
                'name', ws.name,
                'description', ws.description,
                'type', ws.type,
                'config', ws.config,
                'conditions', ws.conditions,
                'step_order', ws.step_order
            ) ORDER BY ws.step_order
        ), 
        NULL
    )
    FROM workflow_steps ws 
    WHERE ws.workflow_id = agent_workflows.id
)
WHERE steps IS NULL;

-- Add comment to document the flexible nature
COMMENT ON COLUMN agent_workflows.steps IS 'Flexible JSON field for storing workflow steps. Structure can evolve over time without database migrations.';

COMMIT; 