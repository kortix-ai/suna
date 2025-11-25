-- Comprehensive Database Index Optimizations
-- This migration adds composite, partial, and expression indexes to optimize query performance
--
-- NOTE: This migration was run manually via psql (not via supabase db push)
-- because the messages table indexes require CONCURRENTLY which doesn't work with the CLI.
-- See: backend/supabase/RUN_VIA_PSQL_index_optimisations.sql

-- ============================================================================
-- PRIORITY 1: Critical High-Frequency Queries
-- ============================================================================

-- agent_runs: Active runs polling (mobile app polls every 15s)
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_status 
ON agent_runs(thread_id, status);

-- agent_runs: Thread history (called on every thread view)
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created_desc 
ON agent_runs(thread_id, created_at DESC);

-- messages indexes created via psql (CONCURRENTLY required for large table)
-- idx_messages_thread_created_desc
-- idx_messages_thread_llm_created
-- idx_messages_thread_type_created_desc
-- idx_messages_thread_optimized_types_created_desc
-- idx_messages_thread_type_llm_summary_created_desc

-- threads: Dashboard thread list (CRITICAL - called on every dashboard load)
CREATE INDEX IF NOT EXISTS idx_threads_account_created_desc 
ON threads(account_id, created_at DESC);

-- credit_ledger: Filtered transactions (user filtering transactions)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_type_created_desc 
ON credit_ledger(account_id, type, created_at DESC);

-- ============================================================================
-- PRIORITY 2: High-Impact Queries
-- ============================================================================

-- credit_ledger: Usage queries (debits only - HIGH impact for usage calculations)
CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_created_debit 
ON credit_ledger(account_id, created_at DESC) 
WHERE amount < 0;

-- agent_triggers: Active composio webhook matching (CRITICAL for webhook routing)
CREATE INDEX IF NOT EXISTS idx_agent_triggers_composio_active 
ON agent_triggers((config->>'composio_trigger_id'), is_active) 
WHERE trigger_type = 'webhook';

-- agents: Agent list sorting by created_at (agent list page)
CREATE INDEX IF NOT EXISTS idx_agents_account_created_desc 
ON agents(account_id, created_at DESC);

-- agents: Agent list sorting by updated_at (agent list page)
CREATE INDEX IF NOT EXISTS idx_agents_account_updated_desc 
ON agents(account_id, updated_at DESC);

-- agent_versions: Latest version lookup (version lookups)
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_version_desc 
ON agent_versions(agent_id, version_number DESC);

-- agent_templates: Marketplace sorting (marketplace page)
CREATE INDEX IF NOT EXISTS idx_agent_templates_public_download_published_desc 
ON agent_templates(is_public, download_count DESC, marketplace_published_at DESC);

-- agent_templates: User templates (user template page)
CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_created_desc 
ON agent_templates(creator_id, created_at DESC);

-- ============================================================================
-- PRIORITY 3: Medium-Impact Optimizations
-- ============================================================================

-- agent_runs: Recent agent lookup (called when getting thread agent)
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_agent_created_desc 
ON agent_runs(thread_id, agent_id, created_at DESC);

-- agent_runs: Admin status filtering (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created_desc 
ON agent_runs(status, created_at DESC);

-- threads: Admin thread queries (admin dashboard)
CREATE INDEX IF NOT EXISTS idx_threads_account_updated_desc 
ON threads(account_id, updated_at DESC);

-- threads: Project-based queries (project access checks)
CREATE INDEX IF NOT EXISTS idx_threads_project_account 
ON threads(project_id, account_id);

-- agent_templates: Filtered marketplace (filtered marketplace)
CREATE INDEX IF NOT EXISTS idx_agent_templates_public_kortix_created_desc 
ON agent_templates(is_public, is_kortix_team, created_at DESC);

-- agent_templates: Text search for marketplace (requires pg_trgm extension)
CREATE INDEX IF NOT EXISTS idx_agent_templates_name_trgm 
ON agent_templates USING gin (name gin_trgm_ops);

-- ============================================================================
-- Analyze tables to update statistics for query planner
-- ============================================================================

ANALYZE agent_runs;
ANALYZE threads;
ANALYZE credit_ledger;
ANALYZE agent_triggers;
ANALYZE agents;
ANALYZE agent_versions;
ANALYZE agent_templates;
