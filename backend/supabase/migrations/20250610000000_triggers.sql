-- Trigger system tables

-- Enum type if using Postgres enums; but we use plain text with CHECK.

CREATE TABLE IF NOT EXISTS public.triggers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    project_id uuid,
    name text NOT NULL,
    description text,
    type text NOT NULL CHECK (type IN ('webhook','cron','event')),
    config jsonb,
    enabled boolean NOT NULL DEFAULT TRUE,
    secret text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.trigger_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_id uuid REFERENCES public.triggers(id) ON DELETE CASCADE,
    agent_run_id uuid REFERENCES public.agent_runs(id) ON DELETE SET NULL,
    status text NOT NULL,
    fired_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    error text,
    debug_payload jsonb
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_trigger_runs_trigger_id ON public.trigger_runs(trigger_id); 