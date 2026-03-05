-- AGENTPRESS SCHEMA:
-- Create projects table
CREATE TABLE projects (
    project_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    sandbox JSONB DEFAULT '{}'::jsonb,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create threads table
CREATE TABLE threads (
    thread_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(project_id) ON DELETE CASCADE,
    is_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create messages table
CREATE TABLE messages (
    message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    is_llm_message BOOLEAN NOT NULL DEFAULT TRUE,
    content JSONB NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create agent_runs table
CREATE TABLE agent_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(thread_id),
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    responses JSONB NOT NULL DEFAULT '[]'::jsonb, -- TO BE REMOVED, NOT USED 
    error TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = TIMEZONE('utc'::text, NOW());
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
CREATE TRIGGER update_threads_updated_at
    BEFORE UPDATE ON threads
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_messages_updated_at
    BEFORE UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_runs_updated_at
    BEFORE UPDATE ON agent_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create indexes for better query performance
CREATE INDEX idx_threads_created_at ON threads(created_at);
CREATE INDEX idx_threads_account_id ON threads(account_id);
CREATE INDEX idx_threads_project_id ON threads(project_id);
CREATE INDEX idx_agent_runs_thread_id ON agent_runs(thread_id);
CREATE INDEX idx_agent_runs_status ON agent_runs(status);
CREATE INDEX idx_agent_runs_created_at ON agent_runs(created_at);
CREATE INDEX idx_projects_account_id ON projects(account_id);
CREATE INDEX idx_projects_created_at ON projects(created_at);
CREATE INDEX idx_messages_thread_id ON messages(thread_id);
CREATE INDEX idx_messages_created_at ON messages(created_at);

-- Enable Row Level Security
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Project policies
CREATE POLICY project_select_policy ON projects
    FOR SELECT
    USING (
        is_public = TRUE OR
        basejump.has_role_on_account(account_id) = true
    );

CREATE POLICY project_insert_policy ON projects
    FOR INSERT
    WITH CHECK (basejump.has_role_on_account(account_id) = true);

CREATE POLICY project_update_policy ON projects
    FOR UPDATE
    USING (basejump.has_role_on_account(account_id) = true);

CREATE POLICY project_delete_policy ON projects
    FOR DELETE
    USING (basejump.has_role_on_account(account_id) = true);

-- Thread policies based on project and account ownership
CREATE POLICY thread_select_policy ON threads
    FOR SELECT
    USING (
        basejump.has_role_on_account(account_id) = true OR 
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.project_id = threads.project_id
            AND (
                projects.is_public = TRUE OR
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY thread_insert_policy ON threads
    FOR INSERT
    WITH CHECK (
        basejump.has_role_on_account(account_id) = true OR 
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.project_id = threads.project_id
            AND basejump.has_role_on_account(projects.account_id) = true
        )
    );

CREATE POLICY thread_update_policy ON threads
    FOR UPDATE
    USING (
        basejump.has_role_on_account(account_id) = true OR 
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.project_id = threads.project_id
            AND basejump.has_role_on_account(projects.account_id) = true
        )
    );

CREATE POLICY thread_delete_policy ON threads
    FOR DELETE
    USING (
        basejump.has_role_on_account(account_id) = true OR 
        EXISTS (
            SELECT 1 FROM projects
            WHERE projects.project_id = threads.project_id
            AND basejump.has_role_on_account(projects.account_id) = true
        )
    );

-- Create policies for agent_runs based on thread ownership
CREATE POLICY agent_run_select_policy ON agent_runs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = agent_runs.thread_id
            AND (
                projects.is_public = TRUE OR
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY agent_run_insert_policy ON agent_runs
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = agent_runs.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY agent_run_update_policy ON agent_runs
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = agent_runs.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY agent_run_delete_policy ON agent_runs
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = agent_runs.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

-- Create message policies based on thread ownership
CREATE POLICY message_select_policy ON messages
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = messages.thread_id
            AND (
                projects.is_public = TRUE OR
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY message_insert_policy ON messages
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = messages.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY message_update_policy ON messages
    FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = messages.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

CREATE POLICY message_delete_policy ON messages
    FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            LEFT JOIN projects ON threads.project_id = projects.project_id
            WHERE threads.thread_id = messages.thread_id
            AND (
                basejump.has_role_on_account(threads.account_id) = true OR 
                basejump.has_role_on_account(projects.account_id) = true
            )
        )
    );

-- Grant permissions to roles
GRANT ALL PRIVILEGES ON TABLE projects TO authenticated, service_role;
GRANT SELECT ON TABLE projects TO anon;
GRANT SELECT ON TABLE threads TO authenticated, anon, service_role;
GRANT SELECT ON TABLE messages TO authenticated, anon, service_role;
GRANT ALL PRIVILEGES ON TABLE agent_runs TO authenticated, service_role;

-- Create a function that matches the Python get_messages behavior
CREATE OR REPLACE FUNCTION get_llm_formatted_messages(p_thread_id UUID)
RETURNS JSONB
SECURITY DEFINER -- Changed to SECURITY DEFINER to allow service role access
LANGUAGE plpgsql
AS $$
DECLARE
    messages_array JSONB := '[]'::JSONB;
    has_access BOOLEAN;
    current_role TEXT;
    latest_summary_id UUID;
    latest_summary_time TIMESTAMP WITH TIME ZONE;
    is_project_public BOOLEAN;
BEGIN
    -- Get current role
    SELECT current_user INTO current_role;
    
    -- Check if associated project is public
    SELECT p.is_public INTO is_project_public
    FROM threads t
    LEFT JOIN projects p ON t.project_id = p.project_id
    WHERE t.thread_id = p_thread_id;
    
    -- Skip access check for service_role or public projects
    IF current_role = 'authenticated' AND NOT is_project_public THEN
        -- Check if thread exists and user has access
        SELECT EXISTS (
            SELECT 1 FROM threads t
            LEFT JOIN projects p ON t.project_id = p.project_id
            WHERE t.thread_id = p_thread_id
            AND (
                basejump.has_role_on_account(t.account_id) = true OR 
                basejump.has_role_on_account(p.account_id) = true
            )
        ) INTO has_access;
        
        IF NOT has_access THEN
            RAISE EXCEPTION 'Thread not found or access denied';
        END IF;
    END IF;

    -- Find the latest summary message if it exists
    SELECT message_id, created_at
    INTO latest_summary_id, latest_summary_time
    FROM messages
    WHERE thread_id = p_thread_id
    AND type = 'summary'
    AND is_llm_message = TRUE
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Log whether a summary was found (helpful for debugging)
    IF latest_summary_id IS NOT NULL THEN
        RAISE NOTICE 'Found latest summary message: id=%, time=%', latest_summary_id, latest_summary_time;
    ELSE
        RAISE NOTICE 'No summary message found for thread %', p_thread_id;
    END IF;

    -- Parse content if it's stored as a string and return proper JSON objects
    WITH parsed_messages AS (
        SELECT 
            message_id,
            CASE 
                WHEN jsonb_typeof(content) = 'string' THEN content::text::jsonb
                ELSE content
            END AS parsed_content,
            created_at,
            type
        FROM messages
        WHERE thread_id = p_thread_id
        AND is_llm_message = TRUE
        AND (
            -- Include the latest summary and all messages after it,
            -- or all messages if no summary exists
            latest_summary_id IS NULL 
            OR message_id = latest_summary_id 
            OR created_at > latest_summary_time
        )
        ORDER BY created_at
    )
    SELECT JSONB_AGG(parsed_content)
    INTO messages_array
    FROM parsed_messages;
    
    -- Handle the case when no messages are found
    IF messages_array IS NULL THEN
        RETURN '[]'::JSONB;
    END IF;
    
    RETURN messages_array;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_llm_formatted_messages TO authenticated, anon, service_role;