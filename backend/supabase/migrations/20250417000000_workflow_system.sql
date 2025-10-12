-- Workflow System Migration
-- This migration creates all necessary tables for the agent workflow system

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum types for workflow system
DO $$ BEGIN
    CREATE TYPE workflow_status AS ENUM ('draft', 'active', 'paused', 'disabled', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE execution_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled', 'timeout');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE trigger_type AS ENUM ('webhook', 'schedule', 'event', 'polling', 'manual', 'workflow');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE node_type AS ENUM ('trigger', 'agent', 'tool', 'condition', 'loop', 'parallel', 'webhook', 'transform', 'delay', 'output');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE connection_type AS ENUM ('data', 'tool', 'processed_data', 'action', 'condition');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Workflows table
CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES auth.users(id),
    status workflow_status DEFAULT 'draft',
    version INTEGER DEFAULT 1,
    definition JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Indexes
    CONSTRAINT workflows_name_project_unique UNIQUE (name, project_id)
);

-- Create indexes for workflows
CREATE INDEX IF NOT EXISTS idx_workflows_project_id ON workflows(project_id);
CREATE INDEX IF NOT EXISTS idx_workflows_account_id ON workflows(account_id);
CREATE INDEX IF NOT EXISTS idx_workflows_status ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_created_by ON workflows(created_by);

-- Workflow executions table
CREATE TABLE IF NOT EXISTS workflow_executions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    workflow_version INTEGER NOT NULL,
    workflow_name VARCHAR(255) NOT NULL,
    execution_context JSONB NOT NULL,
    project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    triggered_by VARCHAR(255),
    scheduled_for TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds FLOAT,
    status execution_status NOT NULL DEFAULT 'pending',
    result JSONB,
    error TEXT,
    nodes_executed INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    cost DECIMAL(10, 4) DEFAULT 0.0,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for workflow_executions
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_project_id ON workflow_executions(project_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_account_id ON workflow_executions(account_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_started_at ON workflow_executions(started_at DESC);

-- Triggers table
CREATE TABLE IF NOT EXISTS triggers (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    type trigger_type NOT NULL,
    config JSONB NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for triggers
CREATE INDEX IF NOT EXISTS idx_triggers_workflow_id ON triggers(workflow_id);
CREATE INDEX IF NOT EXISTS idx_triggers_type ON triggers(type);
CREATE INDEX IF NOT EXISTS idx_triggers_is_active ON triggers(is_active);

-- Webhook registrations table
CREATE TABLE IF NOT EXISTS webhook_registrations (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    trigger_id VARCHAR(255) NOT NULL,
    path VARCHAR(255) UNIQUE NOT NULL,
    secret VARCHAR(255) NOT NULL,
    method VARCHAR(10) DEFAULT 'POST',
    headers_validation JSONB,
    body_schema JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_triggered TIMESTAMP WITH TIME ZONE,
    trigger_count INTEGER DEFAULT 0
);

-- Create indexes for webhook_registrations
CREATE INDEX IF NOT EXISTS idx_webhook_registrations_workflow_id ON webhook_registrations(workflow_id);
CREATE INDEX IF NOT EXISTS idx_webhook_registrations_path ON webhook_registrations(path);
CREATE INDEX IF NOT EXISTS idx_webhook_registrations_is_active ON webhook_registrations(is_active);

-- Scheduled jobs table
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    trigger_id VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(255) NOT NULL,
    timezone VARCHAR(50) DEFAULT 'UTC',
    start_date TIMESTAMP WITH TIME ZONE,
    end_date TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    last_run TIMESTAMP WITH TIME ZONE,
    next_run TIMESTAMP WITH TIME ZONE,
    run_count INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0,
    max_consecutive_failures INTEGER DEFAULT 5,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for scheduled_jobs
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_workflow_id ON scheduled_jobs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_is_active ON scheduled_jobs(is_active);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run);

-- Workflow templates table
CREATE TABLE IF NOT EXISTS workflow_templates (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    category VARCHAR(100) NOT NULL,
    workflow_definition JSONB NOT NULL,
    required_variables JSONB,
    required_tools TEXT[],
    required_models TEXT[],
    author VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    tags TEXT[],
    preview_image TEXT,
    usage_count INTEGER DEFAULT 0,
    rating DECIMAL(3, 2) DEFAULT 0.0,
    is_featured BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for workflow_templates
CREATE INDEX IF NOT EXISTS idx_workflow_templates_category ON workflow_templates(category);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_is_featured ON workflow_templates(is_featured);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_rating ON workflow_templates(rating DESC);

-- Workflow execution logs table (for detailed logging)
CREATE TABLE IF NOT EXISTS workflow_execution_logs (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    node_id VARCHAR(255) NOT NULL,
    node_name VARCHAR(255),
    node_type node_type,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,
    status execution_status NOT NULL,
    input_data JSONB,
    output_data JSONB,
    error TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost DECIMAL(10, 4) DEFAULT 0.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for workflow_execution_logs
CREATE INDEX IF NOT EXISTS idx_workflow_execution_logs_execution_id ON workflow_execution_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_execution_logs_node_id ON workflow_execution_logs(node_id);
CREATE INDEX IF NOT EXISTS idx_workflow_execution_logs_status ON workflow_execution_logs(status);

-- Workflow variables table (for storing workflow-specific variables/secrets)
CREATE TABLE IF NOT EXISTS workflow_variables (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    value TEXT,
    is_secret BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT workflow_variables_unique UNIQUE (workflow_id, name)
);

-- Create indexes for workflow_variables
CREATE INDEX IF NOT EXISTS idx_workflow_variables_workflow_id ON workflow_variables(workflow_id);

-- Row Level Security (RLS) Policies

-- Enable RLS on all tables
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_execution_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_variables ENABLE ROW LEVEL SECURITY;

-- Workflows policies (using basejump pattern)
DO $$ BEGIN
    CREATE POLICY "Users can view workflows in their accounts" ON workflows
        FOR SELECT USING (
            basejump.has_role_on_account(account_id) = true OR
            EXISTS (
                SELECT 1 FROM projects
                WHERE projects.project_id = workflows.project_id
                AND projects.is_public = TRUE
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;
    
DO $$ BEGIN
    CREATE POLICY "Users can create workflows in their accounts" ON workflows
        FOR INSERT WITH CHECK (
            basejump.has_role_on_account(account_id) = true
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can update workflows in their accounts" ON workflows
        FOR UPDATE USING (
            basejump.has_role_on_account(account_id) = true
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can delete workflows in their accounts" ON workflows
        FOR DELETE USING (
            basejump.has_role_on_account(account_id) = true
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Workflow executions policies
DO $$ BEGIN
    CREATE POLICY "Users can view executions in their accounts" ON workflow_executions
        FOR SELECT USING (
            basejump.has_role_on_account(account_id) = true OR
            EXISTS (
                SELECT 1 FROM workflows w
                JOIN projects p ON w.project_id = p.project_id
                WHERE w.id = workflow_executions.workflow_id
                AND p.is_public = TRUE
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can insert executions" ON workflow_executions
        FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can update executions" ON workflow_executions
        FOR UPDATE USING (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Triggers policies
DO $$ BEGIN
    CREATE POLICY "Users can view triggers in their workflows" ON triggers
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM workflows 
                WHERE workflows.id = triggers.workflow_id
                AND basejump.has_role_on_account(workflows.account_id) = true
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access to webhook_registrations" ON webhook_registrations
        FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role full access to scheduled_jobs" ON scheduled_jobs
        FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Public can view workflow templates" ON workflow_templates
        FOR SELECT USING (true);
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can manage workflow templates" ON workflow_templates
        FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can view execution logs in their accounts" ON workflow_execution_logs
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM workflow_executions 
                WHERE workflow_executions.id = workflow_execution_logs.execution_id
                AND basejump.has_role_on_account(workflow_executions.account_id) = true
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Service role can insert execution logs" ON workflow_execution_logs
        FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'service_role');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can manage variables for their workflows" ON workflow_variables
        FOR ALL USING (
            EXISTS (
                SELECT 1 FROM workflows 
                WHERE workflows.id = workflow_variables.workflow_id
                AND basejump.has_role_on_account(workflows.account_id) = true
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Functions for automatic timestamp updates
-- Note: update_updated_at_column function already exists from previous migrations

-- Create triggers for updated_at
DO $$ BEGIN
    CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON workflows
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_triggers_updated_at BEFORE UPDATE ON triggers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_scheduled_jobs_updated_at BEFORE UPDATE ON scheduled_jobs
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_workflow_templates_updated_at BEFORE UPDATE ON workflow_templates
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TRIGGER update_workflow_variables_updated_at BEFORE UPDATE ON workflow_variables
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Function to clean up old execution logs (can be called periodically)
CREATE OR REPLACE FUNCTION cleanup_old_execution_logs(days_to_keep INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM workflow_execution_logs
    WHERE created_at < NOW() - INTERVAL '1 day' * days_to_keep;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get workflow execution statistics
CREATE OR REPLACE FUNCTION get_workflow_statistics(p_workflow_id UUID)
RETURNS TABLE (
    total_executions BIGINT,
    successful_executions BIGINT,
    failed_executions BIGINT,
    average_duration_seconds FLOAT,
    total_cost DECIMAL,
    total_tokens BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*)::BIGINT as total_executions,
        COUNT(*) FILTER (WHERE status = 'completed')::BIGINT as successful_executions,
        COUNT(*) FILTER (WHERE status = 'failed')::BIGINT as failed_executions,
        AVG(duration_seconds)::FLOAT as average_duration_seconds,
        SUM(cost)::DECIMAL as total_cost,
        SUM(tokens_used)::BIGINT as total_tokens
    FROM workflow_executions
    WHERE workflow_id = p_workflow_id;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions to roles
GRANT ALL PRIVILEGES ON TABLE workflows TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE workflow_executions TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE triggers TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE webhook_registrations TO service_role;
GRANT ALL PRIVILEGES ON TABLE scheduled_jobs TO service_role;
GRANT SELECT ON TABLE workflow_templates TO authenticated, anon;
GRANT ALL PRIVILEGES ON TABLE workflow_templates TO service_role;
GRANT SELECT ON TABLE workflow_execution_logs TO authenticated;
GRANT ALL PRIVILEGES ON TABLE workflow_execution_logs TO service_role;
GRANT ALL PRIVILEGES ON TABLE workflow_variables TO authenticated, service_role;

-- Add comments for documentation
COMMENT ON TABLE workflows IS 'Stores workflow definitions and configurations';
COMMENT ON TABLE workflow_executions IS 'Records of workflow execution instances';
COMMENT ON TABLE triggers IS 'Workflow trigger configurations';
COMMENT ON TABLE webhook_registrations IS 'Webhook endpoints for workflow triggers';
COMMENT ON TABLE scheduled_jobs IS 'Scheduled workflow executions';
COMMENT ON TABLE workflow_templates IS 'Pre-built workflow templates';
COMMENT ON TABLE workflow_execution_logs IS 'Detailed logs for workflow node executions';
COMMENT ON TABLE workflow_variables IS 'Workflow-specific variables and secrets'; 