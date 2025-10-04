-- Agent Triggers System Migration
-- This migration creates tables for the agent trigger system

BEGIN;

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enum for trigger types
DO $$ BEGIN
    CREATE TYPE agent_trigger_type AS ENUM ('telegram', 'slack', 'webhook', 'schedule', 'email', 'github', 'discord', 'teams');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Agent triggers table
CREATE TABLE IF NOT EXISTS agent_triggers (
    trigger_id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    trigger_type agent_trigger_type NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger events log table for auditing
CREATE TABLE IF NOT EXISTS trigger_events (
    event_id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    trigger_id UUID NOT NULL REFERENCES agent_triggers(trigger_id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    trigger_type agent_trigger_type NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    success BOOLEAN NOT NULL,
    should_execute_agent BOOLEAN DEFAULT FALSE,
    error_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Custom trigger providers table for dynamic provider definitions
CREATE TABLE IF NOT EXISTS custom_trigger_providers (
    provider_id VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    trigger_type VARCHAR(50) NOT NULL,
    provider_class TEXT, -- Full import path for custom providers
    config_schema JSONB DEFAULT '{}'::jsonb,
    webhook_enabled BOOLEAN DEFAULT FALSE,
    webhook_config JSONB,
    response_template JSONB,
    field_mappings JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_by UUID REFERENCES basejump.accounts(id)
);

-- OAuth installations table for storing OAuth integration data
CREATE TABLE IF NOT EXISTS oauth_installations (
    installation_id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    trigger_id UUID NOT NULL REFERENCES agent_triggers(trigger_id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL, -- slack, discord, teams, etc.
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_in INTEGER,
    scope TEXT,
    provider_data JSONB DEFAULT '{}'::jsonb, -- Provider-specific data like workspace info
    installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_triggers_agent_id ON agent_triggers(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_trigger_type ON agent_triggers(trigger_type);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_is_active ON agent_triggers(is_active);
CREATE INDEX IF NOT EXISTS idx_agent_triggers_created_at ON agent_triggers(created_at);

CREATE INDEX IF NOT EXISTS idx_trigger_events_trigger_id ON trigger_events(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_events_agent_id ON trigger_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_trigger_events_timestamp ON trigger_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_trigger_events_success ON trigger_events(success);

CREATE INDEX IF NOT EXISTS idx_custom_trigger_providers_trigger_type ON custom_trigger_providers(trigger_type);
CREATE INDEX IF NOT EXISTS idx_custom_trigger_providers_is_active ON custom_trigger_providers(is_active);

CREATE INDEX IF NOT EXISTS idx_oauth_installations_trigger_id ON oauth_installations(trigger_id);
CREATE INDEX IF NOT EXISTS idx_oauth_installations_provider ON oauth_installations(provider);
CREATE INDEX IF NOT EXISTS idx_oauth_installations_installed_at ON oauth_installations(installed_at);

-- Create updated_at trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_agent_triggers_updated_at 
    BEFORE UPDATE ON agent_triggers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_custom_trigger_providers_updated_at 
    BEFORE UPDATE ON custom_trigger_providers
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_oauth_installations_updated_at 
    BEFORE UPDATE ON oauth_installations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable RLS on all tables
ALTER TABLE agent_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trigger_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_trigger_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_installations ENABLE ROW LEVEL SECURITY;

-- RLS Policies for agent_triggers
-- Users can only see triggers for agents they own
CREATE POLICY agent_triggers_select_policy ON agent_triggers
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_triggers.agent_id
            AND basejump.has_role_on_account(agents.account_id)
        )
    );

CREATE POLICY agent_triggers_insert_policy ON agent_triggers
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_triggers.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

CREATE POLICY agent_triggers_update_policy ON agent_triggers
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_triggers.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

CREATE POLICY agent_triggers_delete_policy ON agent_triggers
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = agent_triggers.agent_id
            AND basejump.has_role_on_account(agents.account_id, 'owner')
        )
    );

-- RLS Policies for trigger_events
-- Users can see events for triggers on agents they own
CREATE POLICY trigger_events_select_policy ON trigger_events
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM agents
            WHERE agents.agent_id = trigger_events.agent_id
            AND basejump.has_role_on_account(agents.account_id)
        )
    );

-- Service role can insert trigger events
CREATE POLICY trigger_events_insert_policy ON trigger_events
    FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for custom_trigger_providers
-- All authenticated users can view active custom providers
CREATE POLICY custom_trigger_providers_select_policy ON custom_trigger_providers
    FOR SELECT USING (is_active = true);

-- Only users can create custom providers for their account
CREATE POLICY custom_trigger_providers_insert_policy ON custom_trigger_providers
    FOR INSERT WITH CHECK (basejump.has_role_on_account(created_by));

-- Only creator can update their custom providers
CREATE POLICY custom_trigger_providers_update_policy ON custom_trigger_providers
    FOR UPDATE USING (basejump.has_role_on_account(created_by, 'owner'));

-- Only creator can delete their custom providers
CREATE POLICY custom_trigger_providers_delete_policy ON custom_trigger_providers
    FOR DELETE USING (basejump.has_role_on_account(created_by, 'owner'));

-- RLS Policies for oauth_installations
-- Users can see OAuth installations for triggers on agents they own
CREATE POLICY oauth_installations_select_policy ON oauth_installations
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM agent_triggers
            JOIN agents ON agents.agent_id = agent_triggers.agent_id
            WHERE agent_triggers.trigger_id = oauth_installations.trigger_id
            AND basejump.has_role_on_account(agents.account_id)
        )
    );

-- Service role can insert/update/delete OAuth installations
CREATE POLICY oauth_installations_insert_policy ON oauth_installations
    FOR INSERT WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY oauth_installations_update_policy ON oauth_installations
    FOR UPDATE USING (auth.jwt() ->> 'role' = 'service_role');

CREATE POLICY oauth_installations_delete_policy ON oauth_installations
    FOR DELETE USING (auth.jwt() ->> 'role' = 'service_role');

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE agent_triggers TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE trigger_events TO service_role;
GRANT SELECT ON TABLE trigger_events TO authenticated;
GRANT ALL PRIVILEGES ON TABLE custom_trigger_providers TO authenticated, service_role;
GRANT ALL PRIVILEGES ON TABLE oauth_installations TO service_role;
GRANT SELECT ON TABLE oauth_installations TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE agent_triggers IS 'Stores trigger configurations for agents';
COMMENT ON TABLE trigger_events IS 'Audit log of trigger events and their results';
COMMENT ON TABLE custom_trigger_providers IS 'Custom trigger provider definitions for dynamic loading';
COMMENT ON TABLE oauth_installations IS 'OAuth integration data for triggers (tokens, workspace info, etc.)';

COMMENT ON COLUMN agent_triggers.config IS 'Provider-specific configuration including credentials and settings';
COMMENT ON COLUMN trigger_events.metadata IS 'Additional event data and processing results';
COMMENT ON COLUMN custom_trigger_providers.provider_class IS 'Full Python import path for custom provider classes';
COMMENT ON COLUMN custom_trigger_providers.field_mappings IS 'Maps webhook fields to execution variables using dot notation';
COMMENT ON COLUMN oauth_installations.provider_data IS 'Provider-specific data like workspace info, bot details, etc.';

COMMIT; 