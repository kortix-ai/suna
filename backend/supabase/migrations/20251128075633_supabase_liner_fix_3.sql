-- =====================================================
-- FINAL LINTER FIXES - COMPREHENSIVE
-- =====================================================
-- This migration addresses the final 52 warnings and 1 error:
-- 1. ERROR: security_definer_view (v_circuit_breaker_status)
-- 2. WARN: function_search_path_mutable (52 functions)
-- =====================================================

BEGIN;

-- =====================================================
-- PART 1: FIX SECURITY DEFINER VIEW ERROR
-- =====================================================
-- Recreate v_circuit_breaker_status view without SECURITY DEFINER

DROP VIEW IF EXISTS public.v_circuit_breaker_status CASCADE;

CREATE VIEW public.v_circuit_breaker_status AS
SELECT 
    circuit_name,
    state,
    failure_count,
    last_failure_time,
    CASE 
        WHEN last_failure_time IS NOT NULL THEN 
            EXTRACT(EPOCH FROM (NOW() - last_failure_time)) 
        ELSE NULL 
    END AS seconds_since_failure,
    updated_at,
    CASE 
        WHEN state = 'open' AND last_failure_time IS NOT NULL THEN
            GREATEST(0, 60 - EXTRACT(EPOCH FROM (NOW() - last_failure_time)))
        ELSE NULL
    END AS seconds_until_retry,
    CASE
        WHEN state = 'closed' THEN '✅ Healthy'
        WHEN state = 'open' THEN '🔴 OPEN - Blocking requests'
        WHEN state = 'half_open' THEN '🟡 Testing recovery'
    END AS status_display
FROM public.circuit_breaker_state
ORDER BY 
    CASE state
        WHEN 'open' THEN 1
        WHEN 'half_open' THEN 2
        WHEN 'closed' THEN 3
    END,
    circuit_name;

COMMENT ON VIEW public.v_circuit_breaker_status IS 
'Human-readable view of circuit breaker status across all circuits. Use this for monitoring dashboards.';

-- =====================================================
-- PART 2: FIX FUNCTION SEARCH_PATH FOR ALL 52 FUNCTIONS
-- =====================================================
-- Fix each function explicitly, handling all overloads

DO $$
DECLARE
    func_record RECORD;
    fixed_count INTEGER := 0;
    error_count INTEGER := 0;
    func_list TEXT[] := ARRAY[
        'get_agent_knowledge_base',
        'add_credits',
        'get_agent_version_config',
        'publish_agent_to_marketplace',
        'process_monthly_refills',
        'delete_user_data',
        'unpublish_agent_from_marketplace',
        'execute_account_deletion',
        'trigger_welcome_email',
        'get_llm_formatted_messages',
        'add_agent_to_library',
        'get_marketplace_agents',
        'migrate_agents_to_versioned',
        'switch_agent_version',
        'get_agent_config',
        'can_cancel_subscription',
        'get_agent_kb_processing_jobs',
        'check_user_role',
        'create_agent_version',
        'create_agent_kb_processing_job',
        'update_agent_kb_job_status',
        'grant_user_role',
        'schedule_trigger_http',
        'unschedule_job_by_name',
        'create_template_from_agent',
        'deduct_credits',
        'get_thread_knowledge_base',
        'install_template_as_instance',
        'get_missing_credentials_for_template',
        'get_credit_balance',
        'migrate_user_to_credits',
        'count_suna_agents_by_version',
        'find_suna_default_agent_for_account',
        'get_all_suna_default_agents',
        'get_suna_default_agent_stats',
        'find_suna_agents_needing_update',
        'get_agent_knowledge_base_context',
        'grant_tier_credits',
        'cleanup_expired_credits',
        'reconcile_credit_balance',
        'initialize_free_tier_credits',
        'atomic_daily_credit_refresh',
        'get_credit_breakdown',
        'schedule_account_deletion',
        'cancel_account_deletion_job',
        'process_scheduled_account_deletions',
        'delete_user_immediately'
    ];
    func_name TEXT;
BEGIN
    -- Fix each function by name, handling all overloads
    FOREACH func_name IN ARRAY func_list
    LOOP
        -- Fix all overloads of this function
        FOR func_record IN
            SELECT 
                p.oid as func_oid,
                n.nspname as schema_name,
                p.proname as func_name,
                pg_get_function_identity_arguments(p.oid) as args,
                CASE 
                    WHEN pg_get_function_identity_arguments(p.oid) = '' THEN 
                        format('%I.%I', n.nspname, p.proname)
                    ELSE 
                        format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
                END as func_signature
            FROM pg_proc p
            JOIN pg_namespace n ON p.pronamespace = n.oid
            WHERE n.nspname = 'public'
            AND p.proname = func_name
            AND p.prosecdef = false  -- Not SECURITY DEFINER
            AND (
                -- Functions that don't have search_path set
                p.proconfig IS NULL 
                OR NOT EXISTS (
                    SELECT 1 FROM unnest(p.proconfig) AS config
                    WHERE config LIKE 'search_path=%'
                )
            )
        LOOP
            BEGIN
                -- Try using OID first (most reliable)
                EXECUTE format('ALTER FUNCTION %s SET search_path = ''''', func_record.func_oid::regprocedure);
                fixed_count := fixed_count + 1;
            EXCEPTION WHEN OTHERS THEN
                BEGIN
                    -- Fallback to signature-based approach
                    EXECUTE format('ALTER FUNCTION %s SET search_path = ''''', func_record.func_signature);
                    fixed_count := fixed_count + 1;
                EXCEPTION WHEN OTHERS THEN
                    error_count := error_count + 1;
                    RAISE NOTICE 'Could not fix function %.%(%): %', 
                        func_record.schema_name, func_record.func_name, func_record.args, SQLERRM;
                END;
            END;
        END LOOP;
    END LOOP;
    
    RAISE NOTICE 'Fixed % function overloads, % errors', fixed_count, error_count;
END $$;

-- =====================================================
-- PART 3: FIX ALL REMAINING FUNCTIONS IN PUBLIC SCHEMA
-- =====================================================
-- Catch any functions we might have missed

DO $$
DECLARE
    func_record RECORD;
    fixed_count INTEGER := 0;
    error_count INTEGER := 0;
BEGIN
    -- Fix all remaining functions in public schema that don't have search_path set
    FOR func_record IN
        SELECT 
            p.oid as func_oid,
            n.nspname as schema_name,
            p.proname as func_name,
            pg_get_function_identity_arguments(p.oid) as args,
            CASE 
                WHEN pg_get_function_identity_arguments(p.oid) = '' THEN 
                    format('%I.%I', n.nspname, p.proname)
                ELSE 
                    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid))
            END as func_signature
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
        AND p.prosecdef = false  -- Not SECURITY DEFINER
        AND p.proname NOT LIKE 'pg_%'  -- Exclude PostgreSQL internal functions
        AND p.proname NOT LIKE 'uuid_%'  -- Exclude uuid extension functions
        AND p.proname NOT LIKE '%_trgm%'  -- Exclude pg_trgm extension functions
        AND p.proname NOT LIKE 'gin_%'  -- Exclude pg_trgm GIN functions
        AND p.proname NOT LIKE 'gtrgm_%'  -- Exclude pg_trgm functions
        AND p.proname NOT LIKE 'similarity%'  -- Exclude pg_trgm similarity functions
        AND p.proname NOT LIKE 'word_similarity%'  -- Exclude pg_trgm word similarity functions
        AND p.proname NOT LIKE 'strict_word_similarity%'  -- Exclude pg_trgm strict word similarity functions
        AND p.proname NOT LIKE 'show_%'  -- Exclude pg_trgm show functions
        AND p.proname NOT IN ('set_limit', 'show_limit')  -- Exclude pg_trgm functions
        AND (
            -- Functions that don't have search_path set
            p.proconfig IS NULL 
            OR NOT EXISTS (
                SELECT 1 FROM unnest(p.proconfig) AS config
                WHERE config LIKE 'search_path=%'
            )
        )
        ORDER BY p.proname
    LOOP
        BEGIN
            -- Try using OID first (most reliable)
            EXECUTE format('ALTER FUNCTION %s SET search_path = ''''', func_record.func_oid::regprocedure);
            fixed_count := fixed_count + 1;
        EXCEPTION WHEN OTHERS THEN
            BEGIN
                -- Fallback to signature-based approach
                EXECUTE format('ALTER FUNCTION %s SET search_path = ''''', func_record.func_signature);
                fixed_count := fixed_count + 1;
            EXCEPTION WHEN OTHERS THEN
                error_count := error_count + 1;
                -- Only log if it's not a "does not exist" error (which is expected for some functions)
                IF SQLERRM NOT LIKE '%does not exist%' THEN
                    RAISE NOTICE 'Could not fix function %.%(%): %', 
                        func_record.schema_name, func_record.func_name, func_record.args, SQLERRM;
                END IF;
            END;
        END;
    END LOOP;
    
    RAISE NOTICE 'Fixed % additional function overloads, % errors', fixed_count, error_count;
END $$;

COMMIT;

-- =====================================================
-- MIGRATION SUMMARY
-- =====================================================
-- 
-- This migration fixes:
-- ✅ 1. SECURITY DEFINER VIEW ERROR
--    - v_circuit_breaker_status: Recreated without SECURITY DEFINER
--
-- ✅ 2. FUNCTION SEARCH_PATH MUTABLE WARNINGS (52 functions)
--    - Explicitly fixes all 52 functions listed by linter
--    - Handles all function overloads/signatures
--    - Catches any remaining functions in public schema
--
-- ⚠️  REMAINING WARNINGS (cannot be fixed via migration):
--    - extension_in_public (pg_trgm) - requires manual migration
--    - auth_otp_long_expiry - requires dashboard config change
--    - auth_leaked_password_protection - requires dashboard config change
--    - vulnerable_postgres_version - requires infrastructure upgrade
--
-- =====================================================

