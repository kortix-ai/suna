CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_is_public_account_id 
ON public.agents(is_public, account_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_account_id_is_public 
ON public.agents(account_id, is_public);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_is_public_account_id 
ON public.projects(is_public, account_id) 
WHERE is_public IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_account_id_is_public 
ON public.projects(account_id, is_public) 
WHERE is_public IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_is_public_account_id 
ON public.threads(is_public, account_id) 
WHERE is_public IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_account_id_is_public 
ON public.threads(account_id, is_public) 
WHERE is_public IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_id_created_at 
ON public.messages(thread_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_file_uploads_account_id_created_at 
ON public.file_uploads(account_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_templates_is_public_creator_id 
ON public.agent_templates(is_public, creator_id) 
WHERE is_public IS NOT NULL;
