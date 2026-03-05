BEGIN;

DROP POLICY IF EXISTS "agents_select_policy" ON public.agents;
CREATE POLICY "agents_select_policy" ON public.agents
    FOR SELECT TO authenticated, anon
    USING (
        is_public = true 
        OR EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agents.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "agents_insert_own" ON public.agents;
CREATE POLICY "agents_insert_own" ON public.agents
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agents.account_id
              AND au.user_id = auth.uid()
              AND au.account_role = 'owner'
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "agents_update_own" ON public.agents;
CREATE POLICY "agents_update_own" ON public.agents
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agents.account_id
              AND au.user_id = auth.uid()
              AND au.account_role = 'owner'
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agents.account_id
              AND au.user_id = auth.uid()
              AND au.account_role = 'owner'
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "agents_delete_own" ON public.agents;
CREATE POLICY "agents_delete_own" ON public.agents
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agents.account_id
              AND au.user_id = auth.uid()
              AND au.account_role = 'owner'
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "project_update_policy" ON public.projects;
CREATE POLICY "project_update_policy" ON public.projects
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = projects.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "project_delete_policy" ON public.projects;
CREATE POLICY "project_delete_policy" ON public.projects
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = projects.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "project_select_policy" ON public.projects;
CREATE POLICY "project_select_policy" ON public.projects
    FOR SELECT TO authenticated, anon
    USING (
        is_public = TRUE 
        OR EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = projects.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );


DROP POLICY IF EXISTS "thread_update_policy" ON public.threads;
CREATE POLICY "thread_update_policy" ON public.threads
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = threads.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "thread_delete_policy" ON public.threads;
CREATE POLICY "thread_delete_policy" ON public.threads
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = threads.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "thread_select_policy" ON public.threads;
CREATE POLICY "thread_select_policy" ON public.threads
    FOR SELECT TO authenticated, anon
    USING (
        is_public IS TRUE
        OR EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = threads.account_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM projects p
            JOIN basejump.account_user au ON au.account_id = p.account_id
            WHERE p.project_id = threads.project_id
              AND (p.is_public IS TRUE OR au.user_id = auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "message_insert_policy" ON public.messages;
CREATE POLICY "message_insert_policy" ON public.messages
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.threads t
            JOIN basejump.account_user au ON au.account_id = t.account_id
            WHERE t.thread_id = messages.thread_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "message_update_policy" ON public.messages;
CREATE POLICY "message_update_policy" ON public.messages
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.threads t
            JOIN basejump.account_user au ON au.account_id = t.account_id
            WHERE t.thread_id = messages.thread_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "message_delete_policy" ON public.messages;
CREATE POLICY "message_delete_policy" ON public.messages
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.threads t
            JOIN basejump.account_user au ON au.account_id = t.account_id
            WHERE t.thread_id = messages.thread_id
              AND au.user_id = auth.uid()
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "message_select_policy" ON public.messages;
CREATE POLICY "message_select_policy" ON public.messages
    FOR SELECT TO authenticated, anon
    USING (
        EXISTS (
            SELECT 1 FROM public.threads t
            WHERE t.thread_id = messages.thread_id
              AND (
                  t.is_public IS TRUE
                  OR EXISTS (
                      SELECT 1 FROM basejump.account_user au
                      WHERE au.account_id = t.account_id
                        AND au.user_id = auth.uid()
                  )
                  OR EXISTS (
                      SELECT 1 FROM projects p
                      WHERE p.project_id = t.project_id
                        AND (
                            p.is_public IS TRUE
                            OR EXISTS (
                                SELECT 1 FROM basejump.account_user au
                                WHERE au.account_id = p.account_id
                                  AND au.user_id = auth.uid()
                            )
                        )
                  )
              )
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "Users can view own credit account" ON public.credit_accounts;
CREATE POLICY "Users can view own credit account" ON public.credit_accounts
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = credit_accounts.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "team_members_can_view_credit_account" ON public.credit_accounts;
CREATE POLICY "team_members_can_view_credit_account" ON public.credit_accounts
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = credit_accounts.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "team_owners_can_manage_credits" ON public.credit_accounts;
CREATE POLICY "team_owners_can_manage_credits" ON public.credit_accounts
    FOR ALL TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = credit_accounts.account_id
              AND au.user_id = auth.uid()
              AND au.account_role = 'owner'
        )
    );

DROP POLICY IF EXISTS "Users can view own ledger" ON public.credit_ledger;
CREATE POLICY "Users can view own ledger" ON public.credit_ledger
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = credit_ledger.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "team_members_can_view_ledger" ON public.credit_ledger;
CREATE POLICY "team_members_can_view_ledger" ON public.credit_ledger
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = credit_ledger.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can view their own file uploads" ON public.file_uploads;
CREATE POLICY "Users can view their own file uploads" ON public.file_uploads
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = file_uploads.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can create their own file uploads" ON public.file_uploads;
CREATE POLICY "Users can create their own file uploads" ON public.file_uploads
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = file_uploads.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can update their own file uploads" ON public.file_uploads;
CREATE POLICY "Users can update their own file uploads" ON public.file_uploads
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = file_uploads.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can delete their own file uploads" ON public.file_uploads;
CREATE POLICY "Users can delete their own file uploads" ON public.file_uploads
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = file_uploads.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can view public templates or their own templates" ON public.agent_templates;
CREATE POLICY "Users can view public templates or their own templates" ON public.agent_templates
    FOR SELECT TO authenticated, anon
    USING (
        is_public = true
        OR EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agent_templates.creator_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can create their own templates" ON public.agent_templates;
CREATE POLICY "Users can create their own templates" ON public.agent_templates
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agent_templates.creator_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can update their own templates" ON public.agent_templates;
CREATE POLICY "Users can update their own templates" ON public.agent_templates
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agent_templates.creator_id
              AND au.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agent_templates.creator_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can delete their own templates" ON public.agent_templates;
CREATE POLICY "Users can delete their own templates" ON public.agent_templates
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = agent_templates.creator_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can view their own feedback" ON public.feedback;
CREATE POLICY "Users can view their own feedback" ON public.feedback
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = feedback.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can insert their own feedback" ON public.feedback;
CREATE POLICY "Users can insert their own feedback" ON public.feedback
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = feedback.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can update their own feedback" ON public.feedback;
CREATE POLICY "Users can update their own feedback" ON public.feedback
    FOR UPDATE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = feedback.account_id
              AND au.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = feedback.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "Users can delete their own feedback" ON public.feedback;
CREATE POLICY "Users can delete their own feedback" ON public.feedback
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM basejump.account_user au
            WHERE au.account_id = feedback.account_id
              AND au.user_id = auth.uid()
        )
    );

DROP POLICY IF EXISTS "agent_runs_select_policy" ON public.agent_runs;
CREATE POLICY "agent_runs_select_policy" ON public.agent_runs
    FOR SELECT TO authenticated, anon
    USING (
        EXISTS (
            SELECT 1 FROM public.threads t
            WHERE t.thread_id = agent_runs.thread_id
              AND (
                  t.is_public IS TRUE
                  OR EXISTS (
                      SELECT 1 FROM basejump.account_user au
                      WHERE au.account_id = t.account_id
                        AND au.user_id = auth.uid()
                  )
              )
        )
        OR EXISTS (
            SELECT 1 FROM public.user_roles ur
            WHERE ur.user_id = auth.uid()
              AND ur.role IN ('admin', 'super_admin')
        )
    );

COMMIT;
