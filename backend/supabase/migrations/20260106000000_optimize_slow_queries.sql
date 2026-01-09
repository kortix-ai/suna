-- Note: CONCURRENTLY is not used here because:
-- 1. Local development databases are empty/reset, so no table locking concerns
-- 2. CREATE INDEX CONCURRENTLY cannot execute inside transactions
-- 3. supabase db reset runs migrations in a transaction pipeline
-- For production, CONCURRENTLY can be added if needed for zero-downtime index creation

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_started_at 
ON agent_runs(status, started_at DESC) 
WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_status 
ON agent_runs(thread_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_account_id 
ON threads(account_id);

CREATE INDEX IF NOT EXISTS idx_accounts_primary_owner_personal 
ON basejump.accounts(primary_owner_user_id, personal_account) 
WHERE personal_account = true;

CREATE INDEX IF NOT EXISTS idx_messages_thread_type_created 
ON messages(thread_id, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_thread_is_llm_created 
ON messages(thread_id, is_llm_message, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_messages_thread_created 
ON messages(thread_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_threads_project_updated_created 
ON threads(project_id, updated_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_projects_categorized_at 
ON projects(last_categorized_at) 
WHERE last_categorized_at IS NOT NULL;

