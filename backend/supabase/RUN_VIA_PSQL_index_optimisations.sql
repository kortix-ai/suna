-- ============================================================================
-- COMPLETE INDEX OPTIMIZATIONS - RUN VIA PSQL
-- ============================================================================
-- This file contains ALL indexes including messages table (requires CONCURRENTLY)
-- 
-- HOW TO RUN:
-- 1. Connect: psql "your-connection-string"
-- 2. Paste this entire file and press Enter
-- ============================================================================

-- Disable statement timeout for large index creation
SET statement_timeout = '0';

-- ============================================================================
-- PRIORITY 1: Critical High-Frequency Queries
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_status 
ON agent_runs(thread_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_created_desc 
ON agent_runs(thread_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_created_desc 
ON messages(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_account_created_desc 
ON threads(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_type_created_desc 
ON credit_ledger(account_id, type, created_at DESC);

-- ============================================================================
-- PRIORITY 2: High-Impact Queries
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_llm_created 
ON messages(thread_id, created_at) 
WHERE is_llm_message = TRUE;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_type_created_desc 
ON messages(thread_id, type, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_optimized_types_created_desc 
ON messages(thread_id, created_at DESC) 
WHERE type IN ('user', 'tool', 'assistant');

CREATE INDEX IF NOT EXISTS idx_credit_ledger_account_created_debit 
ON credit_ledger(account_id, created_at DESC) 
WHERE amount < 0;

CREATE INDEX IF NOT EXISTS idx_agent_triggers_composio_active 
ON agent_triggers((config->>'composio_trigger_id'), is_active) 
WHERE trigger_type = 'webhook';

CREATE INDEX IF NOT EXISTS idx_agents_account_created_desc 
ON agents(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agents_account_updated_desc 
ON agents(account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_version_desc 
ON agent_versions(agent_id, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_agent_templates_public_download_published_desc 
ON agent_templates(is_public, download_count DESC, marketplace_published_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_templates_creator_created_desc 
ON agent_templates(creator_id, created_at DESC);

-- ============================================================================
-- PRIORITY 3: Medium-Impact Optimizations
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_agent_runs_thread_agent_created_desc 
ON agent_runs(thread_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runs_status_created_desc 
ON agent_runs(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_account_updated_desc 
ON threads(account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_project_account 
ON threads(project_id, account_id);

CREATE INDEX IF NOT EXISTS idx_agent_templates_public_kortix_created_desc 
ON agent_templates(is_public, is_kortix_team, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_templates_name_trgm 
ON agent_templates USING gin (name gin_trgm_ops);

-- ============================================================================
-- PRIORITY 4: Low-Impact but Beneficial
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_type_llm_summary_created_desc 
ON messages(thread_id, type, is_llm_message, created_at DESC) 
WHERE type = 'summary';

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

-- ============================================================================
-- Mark migration as applied (so supabase db push skips it)
-- ============================================================================

INSERT INTO supabase_migrations.schema_migrations (version, name) 
VALUES ('20251123153256', 'index_optimisations')
ON CONFLICT (version) DO NOTHING;

