-- Agent Workflows Migration
-- This migration creates tables for agent-specific workflows
-- Simple step-by-step task execution system

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum types for agent workflow system
DO $$ BEGIN
    CREATE TYPE agent_workflow_status AS ENUM ('draft', 'active', 'paused', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE workflow_step_type AS ENUM ('message', 'tool_call', 'condition', 'loop', 'wait', 'input', 'output');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE workflow_execution_status AS ENUM ('pending', 'running', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Agent workflows table
CREATE TABLE IF NOT EXISTS agent_workflows (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status agent_workflow_status DEFAULT 'draft',
    trigger_phrase VARCHAR(255), -- Optional phrase to trigger this workflow
    is_default BOOLEAN DEFAULT FALSE, -- Whether this is the default workflow for the agent
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow steps table
CREATE TABLE IF NOT EXISTS workflow_steps (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type workflow_step_type NOT NULL,
    config JSONB NOT NULL DEFAULT '{}',
    conditions JSONB, -- Conditions for when this step should execute
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    -- Ensure unique order per workflow
    CONSTRAINT workflow_steps_order_unique UNIQUE (workflow_id, step_order)
);

-- Workflow executions table
CREATE TABLE IF NOT EXISTS workflow_executions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    workflow_id UUID NOT NULL REFERENCES agent_workflows(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    thread_id UUID, -- Optional reference to thread if execution is part of a conversation
    triggered_by VARCHAR(255), -- What triggered this execution
    status workflow_execution_status NOT NULL DEFAULT 'pending',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds FLOAT,
    input_data JSONB, -- Input data for the workflow
    output_data JSONB, -- Final output data
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workflow step executions table
CREATE TABLE IF NOT EXISTS workflow_step_executions (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    execution_id UUID NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    status workflow_execution_status NOT NULL DEFAULT 'pending',
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_seconds FLOAT,
    input_data JSONB,
    output_data JSONB,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_workflows_agent_id ON agent_workflows(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_workflows_status ON agent_workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_order ON workflow_steps(workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_id ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_agent_id ON workflow_executions(agent_id);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_status ON workflow_executions(status);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_started_at ON workflow_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_execution_id ON workflow_step_executions(execution_id);
CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_step_id ON workflow_step_executions(step_id);

ALTER TABLE agent_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_executions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can create workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can update workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can delete workflows for their agents" ON agent_workflows;
DROP POLICY IF EXISTS "Users can manage steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can view steps for their workflows" ON workflow_steps;
DROP POLICY IF EXISTS "Users can view executions for their workflows" ON workflow_executions;
DROP POLICY IF EXISTS "Service role can manage executions" ON workflow_executions;
DROP POLICY IF EXISTS "Users can view step executions for their workflows" ON workflow_step_executions;
DROP POLICY IF EXISTS "Service role can manage step executions" ON workflow_step_executions;

CREATE POLICY "Users can view workflows for their agents" ON agent_workflows
    FOR SELECT USING (
        agent_id IN (
            SELECT agent_id FROM agents 
            WHERE basejump.has_role_on_account(account_id)
        )
    );

CREATE POLICY "Users can create workflows for their agents" ON agent_workflows
    FOR INSERT WITH CHECK (
        agent_id IN (
            SELECT agent_id FROM agents 
            WHERE basejump.has_role_on_account(account_id)
        )
    );

CREATE POLICY "Users can update workflows for their agents" ON agent_workflows
    FOR UPDATE USING (
        agent_id IN (
            SELECT agent_id FROM agents 
            WHERE basejump.has_role_on_account(account_id)
        )
    );

CREATE POLICY "Users can delete workflows for their agents" ON agent_workflows
    FOR DELETE USING (
        agent_id IN (
            SELECT agent_id FROM agents 
            WHERE basejump.has_role_on_account(account_id)
        )
    );

-- Workflow steps policies
CREATE POLICY "Users can view steps for their workflows" ON workflow_steps
    FOR SELECT USING (
        workflow_id IN (
            SELECT id FROM agent_workflows 
            WHERE agent_id IN (
                SELECT agent_id FROM agents 
                WHERE basejump.has_role_on_account(account_id)
            )
        )
    );

CREATE POLICY "Users can manage steps for their workflows" ON workflow_steps
    FOR ALL USING (
        workflow_id IN (
            SELECT id FROM agent_workflows 
            WHERE agent_id IN (
                SELECT agent_id FROM agents 
                WHERE basejump.has_role_on_account(account_id)
            )
        )
    );

-- Workflow executions policies
CREATE POLICY "Users can view executions for their workflows" ON workflow_executions
    FOR SELECT USING (
        workflow_id IN (
            SELECT id FROM agent_workflows 
            WHERE agent_id IN (
                SELECT agent_id FROM agents 
                WHERE basejump.has_role_on_account(account_id)
            )
        )
    );

CREATE POLICY "Service role can manage executions" ON workflow_executions
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Workflow step executions policies
CREATE POLICY "Users can view step executions for their workflows" ON workflow_step_executions
    FOR SELECT USING (
        execution_id IN (
            SELECT id FROM workflow_executions
            WHERE workflow_id IN (
                SELECT id FROM agent_workflows 
                WHERE agent_id IN (
                    SELECT agent_id FROM agents 
                    WHERE basejump.has_role_on_account(account_id)
                )
            )
        )
    );

CREATE POLICY "Service role can manage step executions" ON workflow_step_executions
    FOR ALL USING (auth.jwt() ->> 'role' = 'service_role');

-- Create function to update updated_at timestamp if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers for updated_at (drop existing first to avoid conflicts)
DROP TRIGGER IF EXISTS update_agent_workflows_updated_at ON agent_workflows;
DROP TRIGGER IF EXISTS update_workflow_steps_updated_at ON workflow_steps;

CREATE TRIGGER update_agent_workflows_updated_at 
    BEFORE UPDATE ON agent_workflows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workflow_steps_updated_at 
    BEFORE UPDATE ON workflow_steps
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE agent_workflows TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE workflow_steps TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE workflow_executions TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE workflow_step_executions TO authenticated, service_role;

-- Add comments for documentation
COMMENT ON TABLE agent_workflows IS 'Workflows specific to individual agents for step-by-step task execution';
COMMENT ON TABLE workflow_steps IS 'Individual steps within agent workflows';
COMMENT ON TABLE workflow_executions IS 'Records of workflow execution instances';
COMMENT ON TABLE workflow_step_executions IS 'Records of individual step executions within workflows'; 