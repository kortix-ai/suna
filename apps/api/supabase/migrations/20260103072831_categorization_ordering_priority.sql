-- Update categorization ordering: newest created first, then uncategorized before re-categorization
-- This ensures new users get categories faster, while still handling re-categorization
-- Also limits to threads created within the last 7 days (no point categorizing old threads)

CREATE OR REPLACE FUNCTION get_stale_projects_for_categorization(
    stale_threshold TIMESTAMP WITH TIME ZONE,
    max_count INT DEFAULT 50
)
RETURNS TABLE (project_id UUID) 
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT p.project_id
    FROM projects p
    INNER JOIN (
        SELECT t.project_id, 
               MAX(t.updated_at) as last_activity,
               MAX(t.created_at) as newest_thread_created
        FROM threads t
        GROUP BY t.project_id
    ) ta ON ta.project_id = p.project_id
    WHERE ta.last_activity < stale_threshold
      AND (p.last_categorized_at IS NULL OR p.last_categorized_at < ta.last_activity)
      AND ta.newest_thread_created > NOW() - INTERVAL '7 days'  -- Only categorize recent threads
    ORDER BY 
        ta.newest_thread_created DESC,           -- Newest created first (today before yesterday)
        (p.last_categorized_at IS NULL) DESC     -- Then uncategorized before re-categorization
    LIMIT max_count;
$$;

