-- Enable Supabase Cron and HTTP extensions and provide helper RPCs
-- This migration replaces QStash-based scheduling with Supabase Cron

BEGIN;

-- Enable required extensions if not already enabled
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Helper function to schedule an HTTP POST via Supabase Cron
-- Overwrites existing job with the same name
CREATE OR REPLACE FUNCTION public.schedule_trigger_http(
    job_name text,
    schedule text,
    url text,
    headers jsonb DEFAULT '{}'::jsonb,
    body jsonb DEFAULT '{}'::jsonb,
    timeout_ms integer DEFAULT 8000
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    job_id bigint;
    sql_text text;
    headers_fixed jsonb;
    body_fixed jsonb;
BEGIN
    -- Unschedule any existing jobs with the same name
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = job_name;

    -- Normalize headers/body in case callers pass JSON strings instead of objects
    headers_fixed := COALESCE(
        CASE
            WHEN headers IS NULL THEN '{}'::jsonb
            WHEN jsonb_typeof(headers) = 'object' THEN headers
            WHEN jsonb_typeof(headers) = 'string' THEN (
                -- Remove surrounding quotes then unescape to get raw JSON text, finally cast to jsonb
                replace(replace(trim(both '"' from headers::text), '\\"', '"'), '\\\\', '\\')
            )::jsonb
            ELSE '{}'::jsonb
        END,
        '{}'::jsonb
    );

    body_fixed := COALESCE(
        CASE
            WHEN body IS NULL THEN '{}'::jsonb
            WHEN jsonb_typeof(body) = 'object' THEN body
            WHEN jsonb_typeof(body) = 'string' THEN (
                replace(replace(trim(both '"' from body::text), '\\"', '"'), '\\\\', '\\')
            )::jsonb
            ELSE body
        END,
        '{}'::jsonb
    );

    -- Build the SQL snippet to be executed by pg_cron
    sql_text := format(
        $sql$select net.http_post(
            url := %L,
            headers := %L::jsonb,
            body := %L::jsonb,
            timeout_milliseconds := %s
        );$sql$,
        url,
        headers_fixed::text,
        body_fixed::text,
        timeout_ms
    );

    job_id := cron.schedule(job_name, schedule, sql_text);
    RETURN job_id;
END;
$$;

-- Helper to unschedule by job name
CREATE OR REPLACE FUNCTION public.unschedule_job_by_name(job_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
    WHERE j.jobname = job_name;
END;
$$;

-- Grant execute to service role (backend uses service role key)
GRANT EXECUTE ON FUNCTION public.schedule_trigger_http(text, text, text, jsonb, jsonb, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.unschedule_job_by_name(text) TO service_role;

COMMIT;
