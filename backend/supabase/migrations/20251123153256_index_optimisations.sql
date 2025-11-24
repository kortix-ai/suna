-- Comprehensive Database Index Optimizations
-- This migration adds composite, partial, and expression indexes to optimize query performance
-- Indexes are organized by priority: Critical → High → Medium → Low impact queries

BEGIN;

-- ============================================================================
-- PRIORITY 1: Critical High-Frequency Queries
-- ============================================================================

-- agent_runs: Active runs polling (mobile app polls every 15s)
-- Query: .in_('thread_id', thread_ids).eq('status', 'running')
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_status 
ON agent_runs(thread_id, status);

-- agent_runs: Thread history (called on every thread view)
-- Query: .eq('thread_id', thread_id).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created_desc 
ON agent_runs(thread_id, created_at DESC);

-- messages: Message loading (CRITICAL - every message load, paginated batches)
-- Query: .eq('thread_id', thread_id).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_messages_thread_created_desc 
ON messages(thread_id, created_at DESC);

-- threads: Dashboard thread list (CRITICAL - called on every dashboard load)
-- Query: .eq('account_id', user_id).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_threads_account_created_desc 
ON threads(account_id, created_at DESC);

-- credit_ledger: Filtered transactions (user filtering transactions)
-- Query: .eq('account_id', account_id).eq('type', type_filter).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_type_created_desc 
ON credit_ledger(account_id, type, created_at DESC);

-- ============================================================================
-- PRIORITY 2: High-Impact Queries
-- ============================================================================

-- messages: LLM context loading (every agent run loads context)
-- Query: .eq('thread_id', thread_id).eq('is_llm_message', True).order('created_at')
-- Using partial index for smaller size and better performance
CREATE INDEX IF NOT EXISTS idx_messages_thread_llm_created 
ON messages(thread_id, created_at) 
WHERE is_llm_message = TRUE;

-- messages: Type-filtered lookups (latest user/llm_response_end/task_list messages)
-- Query: .eq('thread_id', thread_id).eq('type', 'user').order('created_at', desc=True).limit(1)
CREATE INDEX IF NOT EXISTS idx_messages_thread_type_created_desc 
ON messages(thread_id, type, created_at DESC);

-- messages: Optimized GET Messages endpoint (CRITICAL - every message load with type filtering)
-- Query: .eq('thread_id', thread_id).in_('type', ['user', 'tool', 'assistant']).order('created_at', desc=True)
-- Using partial index for better performance and smaller size
CREATE INDEX IF NOT EXISTS idx_messages_thread_optimized_types_created_desc 
ON messages(thread_id, created_at DESC) 
WHERE type IN ('user', 'tool', 'assistant');

-- credit_ledger: Usage queries (debits only - HIGH impact for usage calculations)
-- Query: .eq('account_id', account_id).lt('amount', 0).gte('created_at', since_date).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_created_debit 
ON credit_ledger(account_id, created_at DESC) 
WHERE amount < 0;

-- agent_triggers: Active composio webhook matching (CRITICAL for webhook routing)
-- Query: .eq('trigger_type', 'webhook').eq('is_active', True).eq('config->>composio_trigger_id', composio_trigger_id)
CREATE INDEX IF NOT EXISTS idx_agent_triggers_composio_active 
ON agent_triggers((config->>'composio_trigger_id'), is_active) 
WHERE trigger_type = 'webhook';

-- agents: Agent list sorting by created_at (agent list page)
-- Query: .eq('account_id', user_id).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agents_account_created_desc 
ON agents(account_id, created_at DESC);

-- agents: Agent list sorting by updated_at (agent list page)
-- Query: .eq('account_id', user_id).order('updated_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agents_account_updated_desc 
ON agents(account_id, updated_at DESC);

-- agent_versions: Latest version lookup (version lookups)
-- Query: .eq('agent_id', agent_id).order('version_number', desc=True).limit(1)
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_version_desc 
ON agent_versions(agent_id, version_number DESC);

-- agent_templates: Marketplace sorting (marketplace page)
-- Query: .eq('is_public', True).order('download_count', desc=True).order('marketplace_published_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agent_templates_public_download_published_desc 
ON agent_templates(is_public, download_count DESC, marketplace_published_at DESC);

-- agent_templates: User templates (user template page)
-- Query: .eq('creator_id', creator_id).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_created_desc 
ON agent_templates(creator_id, created_at DESC);

-- ============================================================================
-- PRIORITY 3: Medium-Impact Optimizations
-- ============================================================================

-- agent_runs: Recent agent lookup (called when getting thread agent)
-- Query: .eq('thread_id', thread_id).not_.is_('agent_id', 'null').order('created_at', desc=True).limit(1)
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_agent_created_desc 
ON agent_runs(thread_id, agent_id, created_at DESC);

-- agent_runs: Admin status filtering (admin dashboard)
-- Query: agent_runs.select('*, threads!inner(account_id)').eq('status', status_filter).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created_desc 
ON agent_runs(status, created_at DESC);

-- threads: Admin thread queries (admin dashboard)
-- Query: .eq('account_id', account_id).order('updated_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_threads_account_updated_desc 
ON threads(account_id, updated_at DESC);

-- threads: Project-based queries (project access checks)
-- Query: .eq('project_id', project_id).eq('account_id', account_id)
CREATE INDEX IF NOT EXISTS idx_threads_project_account 
ON threads(project_id, account_id);

-- agents: Default agent lookup (default agent checks)
-- Query: .eq('account_id', account_id).eq('is_default', True)
-- Note: Unique index idx_agents_account_default already exists from migration 20250524062639
-- This composite index would be redundant, but kept for completeness if unique constraint is removed
-- CREATE INDEX IF NOT EXISTS idx_agents_account_default 
-- ON agents(account_id, is_default) 
-- WHERE is_default = TRUE;

-- agent_templates: Filtered marketplace (filtered marketplace)
-- Query: .eq('is_public', True).eq('is_kortix_team', is_kortix_team).order('created_at', desc=True)
CREATE INDEX IF NOT EXISTS idx_agent_templates_public_kortix_created_desc 
ON agent_templates(is_public, is_kortix_team, created_at DESC);

-- agent_templates: Text search for marketplace (requires pg_trgm extension)
-- Query: .eq('is_public', True).ilike('name', f'%{search}%')
-- Note: pg_trgm extension already exists from previous migrations
CREATE INDEX IF NOT EXISTS idx_agent_templates_name_trgm 
ON agent_templates USING gin (name gin_trgm_ops);

-- ============================================================================
-- PRIORITY 4: Low-Impact but Beneficial
-- ============================================================================

-- messages: Summary message lookup for get_llm_formatted_messages function
-- Query: WHERE thread_id = ? AND type = 'summary' AND is_llm_message = TRUE ORDER BY created_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_messages_thread_type_llm_summary_created_desc 
ON messages(thread_id, type, is_llm_message, created_at DESC) 
WHERE type = 'summary';

-- agent_templates: Tag array search (if tags column exists and is array type)
-- Query: .contains('tags', [tag])
-- Note: Index idx_agent_templates_tags already exists from migration 20250624065047
-- This index creation is skipped as it already exists
-- DO $$
-- BEGIN
--     IF EXISTS (
--         SELECT 1 FROM information_schema.columns 
--         WHERE table_name = 'agent_templates' 
--         AND column_name = 'tags' 
--         AND data_type = 'ARRAY'
--     ) THEN
--         CREATE INDEX IF NOT EXISTS idx_agent_templates_tags_gin 
--         ON agent_templates USING gin (tags);
--     END IF;
-- END $$;

-- ============================================================================
-- Additional Optimizations: Verify Foreign Key Indexes Exist
-- ============================================================================

-- Verify agent_versions has index on agent_id (for cascade deletes and lookups)
-- This already exists from migration 20250525000000_agent_versioning.sql
-- CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_id 
-- ON agent_versions(agent_id);

-- Verify agents has index on account_id (for cascade deletes and user queries)
-- This already exists from migration 20250524062639_agents_table.sql
-- CREATE INDEX IF NOT EXISTS idx_agents_account_id 
-- ON agents(account_id);

-- ============================================================================
-- Analyze tables to update statistics for query planner
-- ============================================================================

ANALYZE agent_runs;
ANALYZE messages;
ANALYZE threads;
ANALYZE credit_ledger;
ANALYZE agent_triggers;
ANALYZE agents;
ANALYZE agent_versions;
ANALYZE agent_templates;

COMMIT;

