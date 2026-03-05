BEGIN;

-- Remove old workflow execution and step tables
-- These are no longer needed since steps are now stored as JSON in agent_workflows.steps
-- and executions can be tracked differently if needed

-- Drop workflow step executions first (has foreign keys to other tables)
DROP TABLE IF EXISTS workflow_step_executions CASCADE;

-- Drop workflow executions 
DROP TABLE IF EXISTS workflow_executions CASCADE;

-- Drop workflow steps
DROP TABLE IF EXISTS workflow_steps CASCADE;

-- Drop the related enum types that are no longer needed
DROP TYPE IF EXISTS workflow_step_type CASCADE;
DROP TYPE IF EXISTS workflow_execution_status CASCADE;

-- Clean up any related indexes that might still exist
DROP INDEX IF EXISTS idx_workflow_steps_workflow_id CASCADE;
DROP INDEX IF EXISTS idx_workflow_steps_order CASCADE;
DROP INDEX IF EXISTS idx_workflow_executions_workflow_id CASCADE;
DROP INDEX IF EXISTS idx_workflow_executions_agent_id CASCADE;
DROP INDEX IF EXISTS idx_workflow_executions_status CASCADE;
DROP INDEX IF EXISTS idx_workflow_executions_started_at CASCADE;
DROP INDEX IF EXISTS idx_workflow_step_executions_execution_id CASCADE;
DROP INDEX IF EXISTS idx_workflow_step_executions_step_id CASCADE;

COMMIT;
