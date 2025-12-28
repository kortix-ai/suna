-- Create benchmark test harness tables
-- Stores E2E test run metadata and detailed results for performance tracking

-- Create enum types
DO $$ BEGIN
    CREATE TYPE benchmark_run_type AS ENUM ('core_test', 'stress_test');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE benchmark_run_status AS ENUM ('running', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE benchmark_result_status AS ENUM ('completed', 'failed', 'timeout', 'error');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Main benchmark runs table
CREATE TABLE IF NOT EXISTS benchmark_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_type benchmark_run_type NOT NULL,
    model_name TEXT NOT NULL,
    concurrency_level INTEGER NOT NULL DEFAULT 1,
    total_prompts INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    status benchmark_run_status NOT NULL DEFAULT 'running',
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Individual test results table
CREATE TABLE IF NOT EXISTS benchmark_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
    prompt_id TEXT NOT NULL,
    prompt_text TEXT NOT NULL,
    thread_id UUID,
    agent_run_id UUID,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    cold_start_time_ms INTEGER,
    total_duration_ms INTEGER,
    tool_calls_count INTEGER DEFAULT 0,
    tool_calls JSONB DEFAULT '[]'::jsonb,
    avg_tool_call_time_ms FLOAT,
    slowest_tool_call JSONB,
    stream_chunk_count INTEGER DEFAULT 0,
    avg_chunk_interval_ms FLOAT,
    status benchmark_result_status NOT NULL DEFAULT 'completed',
    error_message TEXT,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_status ON benchmark_runs(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_run_type ON benchmark_runs(run_type);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created_at ON benchmark_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_created_by ON benchmark_runs(created_by);

CREATE INDEX IF NOT EXISTS idx_benchmark_results_run_id ON benchmark_results(run_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_status ON benchmark_results(status);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_prompt_id ON benchmark_results(prompt_id);
CREATE INDEX IF NOT EXISTS idx_benchmark_results_started_at ON benchmark_results(started_at);

-- Add trigger for updated_at
CREATE OR REPLACE FUNCTION update_benchmark_runs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_benchmark_runs_updated_at ON benchmark_runs;
CREATE TRIGGER trigger_update_benchmark_runs_updated_at
    BEFORE UPDATE ON benchmark_runs
    FOR EACH ROW
    EXECUTE FUNCTION update_benchmark_runs_updated_at();

-- Row Level Security (RLS)
ALTER TABLE benchmark_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE benchmark_results ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything
DROP POLICY IF EXISTS "Service role has full access to benchmark_runs" ON benchmark_runs;
CREATE POLICY "Service role has full access to benchmark_runs" ON benchmark_runs
    FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role has full access to benchmark_results" ON benchmark_results;
CREATE POLICY "Service role has full access to benchmark_results" ON benchmark_results
    FOR ALL USING (true);

-- Policy: Admin users can view all benchmark data
DROP POLICY IF EXISTS "Admins can view benchmark_runs" ON benchmark_runs;
CREATE POLICY "Admins can view benchmark_runs" ON benchmark_runs
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_roles.user_id = auth.uid()
            AND user_roles.role IN ('admin', 'super_admin')
        )
    );

DROP POLICY IF EXISTS "Admins can view benchmark_results" ON benchmark_results;
CREATE POLICY "Admins can view benchmark_results" ON benchmark_results
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM user_roles
            WHERE user_roles.user_id = auth.uid()
            AND user_roles.role IN ('admin', 'super_admin')
        )
    );

-- Comments for documentation
COMMENT ON TABLE benchmark_runs IS 'Stores metadata about E2E benchmark test runs for performance tracking';
COMMENT ON TABLE benchmark_results IS 'Stores detailed results for individual prompts within benchmark runs';
COMMENT ON COLUMN benchmark_runs.run_type IS 'Type of test: core_test (real LLM) or stress_test (mocked LLM)';
COMMENT ON COLUMN benchmark_runs.concurrency_level IS 'Number of concurrent requests during the test';
COMMENT ON COLUMN benchmark_results.cold_start_time_ms IS 'Time from /agent/start call to first SSE stream chunk';
COMMENT ON COLUMN benchmark_results.tool_calls IS 'Array of tool call details with timing information';
COMMENT ON COLUMN benchmark_results.avg_chunk_interval_ms IS 'Average time between SSE stream chunks';

