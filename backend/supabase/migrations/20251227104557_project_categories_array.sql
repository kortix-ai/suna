-- Project-level multi-category support with async categorization
-- Categorizes based on ALL messages after 30 mins of inactivity

-- 1. Add categories array column (keep existing category for backwards compat)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS categories TEXT[] DEFAULT '{}';

-- 2. Migrate existing category data to array
UPDATE projects
SET categories = ARRAY[category]
WHERE category IS NOT NULL 
  AND category != 'Uncategorized' 
  AND category != ''
  AND (categories IS NULL OR categories = '{}');

-- 3. Add last_categorized_at to track when project was last categorized
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_categorized_at TIMESTAMP WITH TIME ZONE;

-- 4. Mark all existing projects as already categorized (skip old projects)
-- Set to updated_at so they won't be picked up until new activity
UPDATE projects SET last_categorized_at = updated_at WHERE last_categorized_at IS NULL;

-- 5. Index for finding stale projects (inactive but not recently categorized)
CREATE INDEX IF NOT EXISTS idx_projects_categorization_stale 
ON projects (updated_at, last_categorized_at) 
WHERE last_categorized_at IS NULL OR last_categorized_at < updated_at;

-- 6. RPC function to find stale projects needing categorization
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
    WHERE p.updated_at < stale_threshold
      AND (p.last_categorized_at IS NULL OR p.last_categorized_at < p.updated_at)
    LIMIT max_count;
$$;

-- 7. Ensure pg_net extension is available
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 8. Function to trigger categorization via HTTP (uses webhook_config table)
CREATE OR REPLACE FUNCTION trigger_stale_project_categorization()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    backend_url TEXT;
    admin_key TEXT;
BEGIN
    SELECT wc.backend_url, wc.webhook_secret 
    INTO backend_url, admin_key
    FROM public.webhook_config wc
    WHERE wc.id = 1;
    
    IF backend_url IS NULL THEN
        RAISE WARNING 'backend_url not configured in webhook_config table';
        RETURN;
    END IF;
    
    PERFORM net.http_post(
        url := backend_url || '/v1/internal/categorize-stale-projects',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Admin-Api-Key', admin_key
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 30000
    );
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to trigger stale project categorization: %', SQLERRM;
END;
$$;

-- 9. Schedule cron job (every 5 minutes)
DO $do$
DECLARE
    v_job_id BIGINT;
BEGIN
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = 'categorize-stale-projects';
    
    v_job_id := cron.schedule(
        'categorize-stale-projects',
        '*/5 * * * *',
        $$SELECT trigger_stale_project_categorization();$$
    );
    
    RAISE NOTICE 'Scheduled project categorization cron job with ID: %', v_job_id;
END $do$;

