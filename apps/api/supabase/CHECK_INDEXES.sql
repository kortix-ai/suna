-- Check if all RLS optimization indexes exist
-- Returns TRUE if all exist, FALSE if any are missing

SELECT 
    CASE 
        WHEN COUNT(*) = 10 THEN TRUE 
        ELSE FALSE 
    END AS all_indexes_exist,
    COUNT(*) AS indexes_found,
    10 AS indexes_expected,
    ARRAY_AGG(indexname ORDER BY indexname) AS existing_indexes
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'idx_agents_is_public_account_id',
    'idx_agents_account_id_is_public',
    'idx_projects_is_public_account_id',
    'idx_projects_account_id_is_public',
    'idx_threads_is_public_account_id',
    'idx_threads_account_id_is_public',
    'idx_messages_thread_id_created_at',
    'idx_file_uploads_account_id_created_at',
    'idx_agent_templates_is_public_creator_id',
    'idx_credit_ledger_account_id'
  );

-- Alternative: Check each index individually
-- Uncomment below to see which specific indexes are missing

/*
SELECT 
    index_name,
    CASE 
        WHEN EXISTS (
            SELECT 1 FROM pg_indexes 
            WHERE schemaname = 'public' 
            AND indexname = index_name
        ) THEN '✓ EXISTS'
        ELSE '✗ MISSING'
    END AS status
FROM (
    VALUES 
        ('idx_agents_is_public_account_id'),
        ('idx_agents_account_id_is_public'),
        ('idx_projects_is_public_account_id'),
        ('idx_projects_account_id_is_public'),
        ('idx_threads_is_public_account_id'),
        ('idx_threads_account_id_is_public'),
        ('idx_messages_thread_id_created_at'),
        ('idx_file_uploads_account_id_created_at'),
        ('idx_agent_templates_is_public_creator_id'),
        ('idx_credit_ledger_account_id')
) AS idx(index_name)
ORDER BY index_name;
*/
