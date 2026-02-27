DROP POLICY IF EXISTS "Users can view workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can create workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can update workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can delete workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Service role can manage workflows" ON agent_workflows;

DROP POLICY IF EXISTS "Users can view steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can create steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can update steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can delete steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can manage steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Service role can manage workflow steps" ON workflow_steps;

DROP POLICY IF EXISTS "Users can view executions for their workflows" ON workflow_executions;
DROP POLICY IF EXISTS "Service role can manage executions" ON workflow_executions;
DROP POLICY IF EXISTS "Service role can manage workflow executions" ON workflow_executions;

DROP POLICY IF EXISTS "Users can view step executions for their workflows" ON workflow_step_executions;
DROP POLICY IF EXISTS "Service role can manage step executions" ON workflow_step_executions;

DROP TRIGGER IF EXISTS update_agent_workflows_updated_at ON agent_workflows;
DROP TRIGGER IF EXISTS update_workflow_steps_updated_at ON workflow_steps;
