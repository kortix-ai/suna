ALTER TABLE agent_workflows DROP CONSTRAINT IF EXISTS agent_workflows_agent_id_fkey;
ALTER TABLE workflow_executions DROP CONSTRAINT IF EXISTS workflow_executions_agent_id_fkey;

ALTER TABLE agent_workflows 
ADD CONSTRAINT agent_workflows_agent_id_fkey 
FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE;

ALTER TABLE workflow_executions 
ADD CONSTRAINT workflow_executions_agent_id_fkey 
FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE CASCADE;

DROP POLICY IF EXISTS "Users can view workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can create workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can update workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can delete workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can view steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can manage steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can view executions for their workflows" ON workflow_executions;
DROP POLICY IF EXISTS "Users can view step executions for their workflows" ON workflow_step_executions;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
