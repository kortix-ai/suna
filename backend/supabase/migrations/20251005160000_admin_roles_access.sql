-- Add admin role bypass to RLS policies
-- Admins from user_roles table can access all threads, messages, projects, and agent_runs

-- Update thread_select_policy to include admin check
DROP POLICY IF EXISTS thread_select_policy ON threads;
CREATE POLICY thread_select_policy ON threads
FOR SELECT
USING (
    is_public IS TRUE
    OR basejump.has_role_on_account(account_id) = true
    OR EXISTS (
        SELECT 1 FROM projects
        WHERE projects.project_id = threads.project_id
        AND (
            projects.is_public IS TRUE
            OR basejump.has_role_on_account(projects.account_id) = true
        )
    )
    OR EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'super_admin')
    )
);

-- Update message_select_policy to include admin check  
DROP POLICY IF EXISTS message_select_policy ON messages;
CREATE POLICY message_select_policy ON messages
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM threads
        WHERE threads.thread_id = messages.thread_id
        AND (
            threads.is_public IS TRUE
            OR threads.account_id = auth.uid()
            OR basejump.has_role_on_account(threads.account_id) = true
            OR EXISTS (
                SELECT 1 FROM projects
                WHERE projects.project_id = threads.project_id
                AND (
                    projects.is_public IS TRUE
                    OR basejump.has_role_on_account(projects.account_id) = true
                )
            )
        )
    )
    OR EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'super_admin')
    )
);

-- Update project_select_policy to include admin check
DROP POLICY IF EXISTS project_select_policy ON projects;
CREATE POLICY project_select_policy ON projects
FOR SELECT
USING (
    is_public = TRUE 
    OR basejump.has_role_on_account(account_id) = true
    OR EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'super_admin')
    )
);

-- Update agent_runs_select_policy to include admin check
DROP POLICY IF EXISTS agent_runs_select_policy ON agent_runs;
CREATE POLICY agent_runs_select_policy ON agent_runs
FOR SELECT
USING (
    EXISTS (
        SELECT 1 FROM threads
        WHERE threads.thread_id = agent_runs.thread_id
        AND (
            threads.is_public = TRUE
            OR threads.account_id = auth.uid()
            OR basejump.has_role_on_account(threads.account_id) = true
            OR EXISTS (
                SELECT 1 FROM projects
                WHERE projects.project_id = threads.project_id
                AND (
                    projects.is_public = TRUE
                    OR basejump.has_role_on_account(projects.account_id) = true
                )
            )
        )
    )
    OR EXISTS (
        SELECT 1 FROM user_roles
        WHERE user_roles.user_id = auth.uid()
        AND user_roles.role IN ('admin', 'super_admin')
    )
);
