-- ==============================================
-- Performance fixes for slow pagination and limits queries
-- Issues identified: 
-- 1. Threads pagination taking 1-4+ seconds
-- 2. Account-state endpoint taking 5-7 seconds
-- 3. Cache broken due to datetime serialization (fixed in code)
-- 4. Single thread/project fetch taking 3.5+ seconds
-- ==============================================

-- THREADS PAGINATION: Add composite index for account_id + created_at ordering
-- Fixes list_user_threads which was doing a full sort after filtering
CREATE INDEX IF NOT EXISTS idx_threads_account_created_desc 
ON threads(account_id, created_at DESC);

-- Add partial index for faster public thread lookups
CREATE INDEX IF NOT EXISTS idx_threads_public 
ON threads(is_public) 
WHERE is_public = true;

-- THREAD ACCESS: Index for single thread lookups with project join
CREATE INDEX IF NOT EXISTS idx_threads_thread_id_project 
ON threads(thread_id, project_id);

-- LIMITS QUERY: Add composite index for running agent runs count
-- The get_all_limits_counts query joins agent_runs with threads on account_id
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_thread 
ON agent_runs(status, thread_id) 
WHERE status = 'running';

-- AGENT RUNS: Index for thread's agent runs lookup
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created_desc 
ON agent_runs(thread_id, created_at DESC);

-- CREDITS QUERY: Add index on credit_accounts for faster lookup
CREATE INDEX IF NOT EXISTS idx_credit_accounts_account_id 
ON credit_accounts(account_id);

-- AGENTS QUERY: Composite index for non-default agents count
CREATE INDEX IF NOT EXISTS idx_agents_account_non_default 
ON agents(account_id) 
WHERE (metadata->>'is_suna_default')::boolean IS NOT TRUE;

-- RESOURCES: Index for sandbox lookup in project/thread queries
CREATE INDEX IF NOT EXISTS idx_resources_id 
ON resources(id);

-- USER ROLES: Index for admin role check
CREATE INDEX IF NOT EXISTS idx_user_roles_user_role 
ON user_roles(user_id, role);

-- ACCOUNT USER: Index for account access check  
CREATE INDEX IF NOT EXISTS idx_account_user_composite 
ON basejump.account_user(user_id, account_id);

