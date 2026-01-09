-- ============================================================================
-- COMPREHENSIVE ZERO DOWNTIME DATABASE OPTIMIZATION
-- ============================================================================
-- Run MANUALLY via psql or Supabase SQL Editor (NOT via migrations)
-- CONCURRENTLY indexes don't lock tables but can't run in transactions
--
-- Usage: psql $DATABASE_URL -f RUN_VIA_PSQL_optimize_limits_queries.sql
--
-- Based on Supabase slow query analysis (2.5M+ calls analyzed)
-- ============================================================================


-- ============================================================================
-- MESSAGES TABLE - CRITICAL (40ms avg, 8 SECOND max spikes!)
-- ============================================================================
-- Total impact: ~135K calls/period, 2.5 MILLION ms total execution time

-- Query: WHERE thread_id = $1 AND is_llm_message = $4 ORDER BY created_at ASC
-- 52K calls, 19.76ms avg, 7.9 SECOND max (!!!)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_llm_created
    ON messages(thread_id, is_llm_message, created_at);

-- Query: WHERE thread_id = $1 AND type = ANY($2) ORDER BY created_at ASC
-- 22K calls, 40.85ms avg, 8.8 SECOND max (!!!)
-- Existing idx_messages_thread_type_created_at has DESC, we need ASC too
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_thread_type_created
    ON messages(thread_id, type, created_at);


-- ============================================================================
-- AGENT_RUNS TABLE - Supabase Index Advisor Recommendation
-- ============================================================================

-- Query: agent_runs JOIN threads WHERE status = 'running' AND started_at >= $5
-- 73K calls, 3.63ms avg, 4.4 SECOND max
-- Supabase Index Advisor: "CREATE INDEX ON public.agent_runs USING btree (started_at)"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_started_at
    ON agent_runs(started_at DESC);

-- Partial index for running status checks (limits API)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_status_thread 
    ON agent_runs(status, thread_id) 
    WHERE status = 'running';


-- ============================================================================
-- BASEJUMP ACCOUNT_USER - Supabase Index Advisor Recommendation
-- ============================================================================

-- Query: basejump.accounts JOIN account_user WHERE user_id = $1
-- 16K calls, 34.42ms avg (consistent latency, high volume)
-- Supabase Index Advisor: "CREATE INDEX ON basejump.account_user USING btree (user_id)"
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_basejump_account_user_user_id
    ON basejump.account_user(user_id);


-- ============================================================================
-- GET_STALE_PROJECTS_FOR_CATEGORIZATION - EXTREMELY SLOW (3.2 SECOND avg!)
-- ============================================================================
-- Query: Subquery does MAX(updated_at), MAX(created_at) GROUP BY project_id
-- 278 calls, 3233ms avg (!!) - Full table scan on threads

-- Index for MAX(updated_at) per project - supports LATERAL ORDER BY updated_at DESC LIMIT 1
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_project_updated
    ON threads(project_id, updated_at DESC);

-- Index for MAX(created_at) per project - supports LATERAL ORDER BY created_at DESC LIMIT 1
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_project_created
    ON threads(project_id, created_at DESC);

-- Fast lookup for categorization filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_last_categorized
    ON projects(last_categorized_at)
    WHERE last_categorized_at IS NOT NULL;


-- ============================================================================
-- THREADS TABLE
-- ============================================================================

-- Query: UPDATE threads SET status = $1 ... WHERE thread_id = $5
-- 20K calls, 18.89ms avg
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_status
    ON threads(status);

-- Thread access authorization (optimized JOIN queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_threads_account_project 
    ON threads(thread_id, account_id, project_id);


-- ============================================================================
-- AGENTS TABLE - Limits API Optimization
-- ============================================================================

-- Fast count of non-Suna-default agents per account
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agents_account_non_suna 
    ON agents(account_id) 
    WHERE (metadata->>'is_suna_default')::boolean IS NOT TRUE;


-- ============================================================================
-- AGENT_TRIGGERS TABLE
-- ============================================================================

-- Trigger limits check grouped by type
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_triggers_agent_type 
    ON agent_triggers(agent_id, trigger_type);


-- ============================================================================
-- RESOURCES & PROJECTS - Sandbox Access Optimization
-- ============================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_resources_external_id_type 
    ON resources(external_id, type);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_sandbox_resource 
    ON projects(sandbox_resource_id) 
    WHERE sandbox_resource_id IS NOT NULL;


-- ============================================================================
-- SYSTEM SCHEMA INDEXES (May require superuser or may already exist)
-- ============================================================================
-- These target Supabase-managed schemas. Run separately if needed.

-- CRON JOB_RUN_DETAILS - 188 SECOND avg (cleanup query)
-- Query: UPDATE cron.job_run_details SET status = $1 WHERE status IN ($3,$4)
-- 2 calls, 188856ms avg (!!) - This is internal cron cleanup
-- UNCOMMENT IF NEEDED (may require elevated permissions):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cron_job_run_details_status
--     ON cron.job_run_details(status);

-- REALTIME SUBSCRIPTION - High volume insert
-- Query: INSERT INTO realtime.subscription with conflict handling
-- 220K calls, 1.59ms avg - Usually has appropriate indexes already
-- UNCOMMENT IF NEEDED (may require elevated permissions):
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_realtime_subscription_lookup
--     ON realtime.subscription(subscription_id, entity);


-- ============================================================================
-- OPTIMIZED get_stale_projects_for_categorization FUNCTION
-- ============================================================================
-- Original: 3.2 SECOND avg due to full GROUP BY scan on threads
-- Optimized: Two LATERAL subqueries use index scans for MAX values

CREATE OR REPLACE FUNCTION get_stale_projects_for_categorization(
    stale_threshold TIMESTAMP WITH TIME ZONE,
    max_count INT DEFAULT 50
)
RETURNS TABLE (project_id UUID) 
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p.project_id
    FROM public.projects p
    -- Get MAX(updated_at) using index scan
    INNER JOIN LATERAL (
        SELECT t.updated_at as last_activity
        FROM public.threads t
        WHERE t.project_id = p.project_id
        ORDER BY t.updated_at DESC
        LIMIT 1
    ) t_updated ON true
    -- Get MAX(created_at) using index scan  
    INNER JOIN LATERAL (
        SELECT t.created_at as newest_thread_created
        FROM public.threads t
        WHERE t.project_id = p.project_id
        ORDER BY t.created_at DESC
        LIMIT 1
    ) t_created ON true
    WHERE t_updated.last_activity < stale_threshold
      AND (p.last_categorized_at IS NULL OR p.last_categorized_at < t_updated.last_activity)
      AND t_created.newest_thread_created > NOW() - INTERVAL '7 days'
    ORDER BY 
        t_created.newest_thread_created DESC,
        (p.last_categorized_at IS NULL) DESC
    LIMIT max_count;
$$;


-- ============================================================================
-- OPTIMIZED update_thread_message_counts TRIGGER
-- ============================================================================
-- Add search_path for security

CREATE OR REPLACE FUNCTION update_thread_message_counts()
RETURNS TRIGGER 
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.threads SET 
      total_message_count = total_message_count + 1,
      user_message_count = user_message_count + CASE WHEN NEW.type = 'user' THEN 1 ELSE 0 END
    WHERE thread_id = NEW.thread_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE public.threads SET 
      total_message_count = GREATEST(total_message_count - 1, 0),
      user_message_count = GREATEST(user_message_count - CASE WHEN OLD.type = 'user' THEN 1 ELSE 0 END, 0)
    WHERE thread_id = OLD.thread_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;


-- ============================================================================
-- VERIFICATION QUERIES (run after indexes complete)
-- ============================================================================
-- Check new indexes were created:
-- SELECT indexname, tablename, indexdef 
-- FROM pg_indexes 
-- WHERE indexname LIKE 'idx_%' 
-- ORDER BY tablename, indexname;

-- Check index usage after some traffic:
-- SELECT schemaname, relname, indexrelname, idx_scan, idx_tup_read
-- FROM pg_stat_user_indexes
-- WHERE indexrelname LIKE 'idx_%'
-- ORDER BY idx_scan DESC;

-- Test categorization function performance:
-- EXPLAIN ANALYZE SELECT * FROM get_stale_projects_for_categorization(NOW() - INTERVAL '30 minutes', 50);

