-- Migration: Add tier filter to category distribution
-- Allows filtering category distribution by subscription tier

-- Update category distribution function to accept optional tier filter
CREATE OR REPLACE FUNCTION get_project_category_distribution(
    start_date TIMESTAMPTZ,
    end_date TIMESTAMPTZ,
    p_tier TEXT DEFAULT NULL
)
RETURNS TABLE(category TEXT, count BIGINT) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(cat, 'Uncategorized')::TEXT as category,
        COUNT(*)::BIGINT as count
    FROM projects p
    LEFT JOIN LATERAL unnest(CASE WHEN p.categories = '{}' OR p.categories IS NULL THEN ARRAY[NULL::TEXT] ELSE p.categories END) AS cat ON true
    -- Join with credit_accounts if tier filter is provided
    LEFT JOIN credit_accounts ca ON p.account_id = ca.account_id
    WHERE p.created_at >= start_date
      AND p.created_at <= end_date
      -- Apply tier filter if provided
      AND (
          p_tier IS NULL 
          OR (
              CASE 
                  WHEN p_tier = 'none' THEN (ca.tier IS NULL OR ca.tier = 'none')
                  ELSE ca.tier = p_tier
              END
          )
      )
    GROUP BY cat
    ORDER BY count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permissions (same signature, updated function)
GRANT EXECUTE ON FUNCTION get_project_category_distribution(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO service_role, authenticated;

