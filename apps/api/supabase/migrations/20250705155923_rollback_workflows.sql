-- Rollback script for old workflow system
DROP TABLE IF EXISTS workflow_flows CASCADE;

-- Drop workflow execution logs (depends on workflow_executions)
DROP TABLE IF EXISTS workflow_execution_logs CASCADE;

-- Drop workflow variables (depends on workflows)
DROP TABLE IF EXISTS workflow_variables CASCADE;

-- Drop webhook registrations (depends on workflows)
DROP TABLE IF EXISTS webhook_registrations CASCADE;

-- Drop scheduled jobs (depends on workflows)
DROP TABLE IF EXISTS scheduled_jobs CASCADE;

-- Drop triggers (depends on workflows)
DROP TABLE IF EXISTS triggers CASCADE;

-- Drop workflow executions (depends on workflows)
DROP TABLE IF EXISTS workflow_executions CASCADE;

-- Drop workflow templates (standalone table)
DROP TABLE IF EXISTS workflow_templates CASCADE;

-- Drop workflows table (main table)
DROP TABLE IF EXISTS workflows CASCADE;

-- Drop workflow-specific functions
DROP FUNCTION IF EXISTS cleanup_old_execution_logs(INTEGER);
DROP FUNCTION IF EXISTS get_workflow_statistics(UUID);

-- Drop enum types (in reverse order of dependencies)
DROP TYPE IF EXISTS connection_type CASCADE;
DROP TYPE IF EXISTS node_type CASCADE;
DROP TYPE IF EXISTS trigger_type CASCADE;
DROP TYPE IF EXISTS execution_status CASCADE;
DROP TYPE IF EXISTS workflow_status CASCADE;
