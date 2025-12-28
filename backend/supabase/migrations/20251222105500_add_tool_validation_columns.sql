-- Migration: Add tool validation columns to benchmark_results
-- Adds tool_call_breakdown, expected_tools_present, and missing_tools columns
-- for better test validation and detailed tool usage tracking

BEGIN;

-- Add tool_call_breakdown column (count of each tool called)
ALTER TABLE benchmark_results 
ADD COLUMN IF NOT EXISTS tool_call_breakdown JSONB DEFAULT '{}'::jsonb;

-- Add expected_tools_present column (validation check)
ALTER TABLE benchmark_results 
ADD COLUMN IF NOT EXISTS expected_tools_present BOOLEAN DEFAULT true;

-- Add missing_tools column (list of expected tools that weren't called)
ALTER TABLE benchmark_results 
ADD COLUMN IF NOT EXISTS missing_tools JSONB DEFAULT '[]'::jsonb;

-- Add comments for documentation
COMMENT ON COLUMN benchmark_results.tool_call_breakdown IS 'Count of each tool called during test execution (e.g., {"web_search": 3, "create_file": 2})';
COMMENT ON COLUMN benchmark_results.expected_tools_present IS 'Boolean flag indicating if all expected tools were called during the test';
COMMENT ON COLUMN benchmark_results.missing_tools IS 'Array of tool names that were expected but not called during the test';

COMMIT;

