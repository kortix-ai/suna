-- Add workflow_flows table for storing visual flow representations
-- This table stores the visual flow data (nodes and edges) separately from the workflow definition

CREATE TABLE IF NOT EXISTS workflow_flows (
    workflow_id UUID PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
    nodes JSONB NOT NULL DEFAULT '[]',
    edges JSONB NOT NULL DEFAULT '[]',
    metadata JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE workflow_flows ENABLE ROW LEVEL SECURITY;

-- RLS policies
DO $$ BEGIN
    CREATE POLICY "Users can view flows for their workflows" ON workflow_flows
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM workflows 
            WHERE workflows.id = workflow_flows.workflow_id
            AND basejump.has_role_on_account(workflows.account_id) = true
        )
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE POLICY "Users can manage flows for their workflows" ON workflow_flows
        FOR ALL USING (
            EXISTS (
                SELECT 1 FROM workflows 
                WHERE workflows.id = workflow_flows.workflow_id
                AND basejump.has_role_on_account(workflows.account_id) = true
            )
        );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create trigger for updated_at
DO $$ BEGIN
    CREATE TRIGGER update_workflow_flows_updated_at BEFORE UPDATE ON workflow_flows
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE workflow_flows TO authenticated, service_role;

-- Add comment
COMMENT ON TABLE workflow_flows IS 'Stores visual flow representations (nodes and edges) for workflows'; 