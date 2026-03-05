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
);
