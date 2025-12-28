BEGIN;

-- RPC function to list users with tier filtering, handling the join between
-- basejump.accounts and credit_accounts at the database level to avoid
-- Supabase client limitations (1000 row limit, URI length limits)

CREATE OR REPLACE FUNCTION public.admin_list_users_by_tier(
    p_tier TEXT DEFAULT NULL,
    p_search_email TEXT DEFAULT NULL,
    p_page INT DEFAULT 1,
    p_page_size INT DEFAULT 20,
    p_sort_by TEXT DEFAULT 'created_at',
    p_sort_order TEXT DEFAULT 'desc'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_offset INT;
    v_total_count INT;
    v_results JSON;
BEGIN
    v_offset := (p_page - 1) * p_page_size;
    
    -- Get total count
    SELECT COUNT(*) INTO v_total_count
    FROM basejump.accounts a
    LEFT JOIN credit_accounts c ON c.account_id = a.id
    LEFT JOIN basejump.billing_customers bc ON bc.account_id = a.id
    WHERE (p_tier IS NULL OR c.tier = p_tier)
      AND (p_search_email IS NULL OR bc.email ILIKE '%' || p_search_email || '%');
    
    -- Get paginated results with dynamic sorting
    SELECT json_agg(row_data) INTO v_results
    FROM (
        SELECT 
            a.id,
            a.created_at,
            COALESCE(bc.email, '') as email,
            COALESCE(c.tier, 'free') as tier,
            COALESCE(c.balance, 0) as credit_balance,
            COALESCE(c.lifetime_purchased, 0) as total_purchased,
            COALESCE(c.lifetime_used, 0) as total_used,
            bs.status as subscription_status,
            c.trial_status
        FROM basejump.accounts a
        LEFT JOIN credit_accounts c ON c.account_id = a.id
        LEFT JOIN basejump.billing_customers bc ON bc.account_id = a.id
        LEFT JOIN LATERAL (
            SELECT status 
            FROM basejump.billing_subscriptions 
            WHERE account_id = a.id 
            ORDER BY created DESC 
            LIMIT 1
        ) bs ON true
        WHERE (p_tier IS NULL OR c.tier = p_tier)
          AND (p_search_email IS NULL OR bc.email ILIKE '%' || p_search_email || '%')
        ORDER BY
            CASE WHEN p_sort_by = 'created_at' AND p_sort_order = 'desc' THEN a.created_at END DESC,
            CASE WHEN p_sort_by = 'created_at' AND p_sort_order = 'asc' THEN a.created_at END ASC,
            CASE WHEN p_sort_by = 'email' AND p_sort_order = 'desc' THEN bc.email END DESC,
            CASE WHEN p_sort_by = 'email' AND p_sort_order = 'asc' THEN bc.email END ASC,
            CASE WHEN p_sort_by = 'balance' AND p_sort_order = 'desc' THEN c.balance END DESC,
            CASE WHEN p_sort_by = 'balance' AND p_sort_order = 'asc' THEN c.balance END ASC,
            CASE WHEN p_sort_by = 'tier' AND p_sort_order = 'desc' THEN c.tier END DESC,
            CASE WHEN p_sort_by = 'tier' AND p_sort_order = 'asc' THEN c.tier END ASC,
            a.created_at DESC -- default fallback
        LIMIT p_page_size
        OFFSET v_offset
    ) row_data;
    
    RETURN json_build_object(
        'data', COALESCE(v_results, '[]'::json),
        'total_count', v_total_count
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users_by_tier(TEXT, TEXT, INT, INT, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_list_users_by_tier IS 'Lists users with optional tier and email filtering, with pagination and sorting. Used by admin billing page.';

COMMIT;
