-- Diagnose the specific slow queries from logs
-- Replace 'ae4ece17-fc6c-4a03-a963-49e589c3fdc0' with your actual user_id

-- =====================================================
-- QUERY 1: AGENTS by account_id (530-548ms - VERY SLOW!)
-- =====================================================

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT agent_id 
FROM agents 
WHERE account_id = 'ae4ece17-fc6c-4a03-a963-49e589c3fdc0' 
  AND current_version_id IS NOT NULL;

-- Expected GOOD:
-- - Execution Time: < 10ms
-- - Index Scan using idx_agents_account_id
-- - Rows scanned ≈ rows returned
--
-- If BAD (still slow):
-- - Seq Scan on agents
-- - Filter with RLS policy
-- - Check if RLS policies are using has_role_on_account

-- =====================================================
-- QUERY 2: ACCOUNTS query (530ms - VERY SLOW!)
-- =====================================================

EXPLAIN (ANALYZE, BUFFERS, VERBOSE)
SELECT 
    a.id as account_id,
    a.name,
    a.slug,
    a.personal_account,
    a.created_at,
    a.updated_at,
    a.public_metadata,
    a.private_metadata
FROM basejump.accounts a
WHERE a.id IN (
    SELECT account_id 
    FROM basejump.account_user 
    WHERE user_id = 'ae4ece17-fc6c-4a03-a963-49e589c3fdc0'
);

-- Expected GOOD:
-- - Execution Time: < 10ms
-- - Index Scan on account_user
-- - Nested Loop or Hash Join
--
-- If BAD:
-- - Seq Scan
-- - RLS policy with function calls

-- =====================================================
-- CHECK: Are RLS policies enabled on these tables?
-- =====================================================

SELECT 
    schemaname,
    tablename,
    rowsecurity
FROM pg_tables
WHERE tablename IN ('agents', 'accounts')
  AND schemaname IN ('public', 'basejump');

-- =====================================================
-- CHECK: What RLS policies exist on agents?
-- =====================================================

SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies
WHERE tablename = 'agents'
  AND schemaname = 'public'
ORDER BY policyname;

-- =====================================================
-- CHECK: What RLS policies exist on accounts?
-- =====================================================

SELECT 
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd,
    qual
FROM pg_policies
WHERE tablename = 'accounts'
  AND schemaname = 'basejump'
ORDER BY policyname;

-- =====================================================
-- CHECK: What indexes exist on agents table?
-- =====================================================

SELECT 
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'agents'
  AND schemaname = 'public'
ORDER BY indexname;

-- =====================================================
-- CHECK: What indexes exist on account_user?
-- =====================================================

SELECT 
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'account_user'
  AND schemaname = 'basejump'
ORDER BY indexname;

-- =====================================================
-- TEST: Simple query without RLS (as superuser)
-- =====================================================

-- Run this to see baseline performance WITHOUT RLS
-- (You'll need superuser access or service_role)

SET ROLE postgres; -- or service_role

-- This bypasses RLS
SELECT agent_id 
FROM agents 
WHERE account_id = 'ae4ece17-fc6c-4a03-a963-49e589c3fdc0' 
  AND current_version_id IS NOT NULL;

RESET ROLE;

-- If this is fast (< 10ms), then RLS is the problem
-- If this is slow (> 500ms), then it's an indexing issue

-- =====================================================
-- CHECK: Table statistics
-- =====================================================

SELECT 
    schemaname,
    tablename,
    n_live_tup as row_count,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE tablename IN ('agents', 'accounts', 'account_user')
ORDER BY tablename;

-- If last_analyze is NULL or old, run ANALYZE
