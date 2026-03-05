BEGIN;

-- Add source type and file metadata to agent knowledge base entries
ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN source_type VARCHAR(50) DEFAULT 'manual' CHECK (source_type IN ('manual', 'file', 'git_repo', 'zip_extracted'));

ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN source_metadata JSONB DEFAULT '{}';

ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN file_path TEXT;

ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN file_size BIGINT;

ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN file_mime_type VARCHAR(255);

ALTER TABLE agent_knowledge_base_entries 
ADD COLUMN extracted_from_zip_id UUID REFERENCES agent_knowledge_base_entries(entry_id) ON DELETE CASCADE;

-- Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_source_type ON agent_knowledge_base_entries(source_type);
CREATE INDEX IF NOT EXISTS idx_agent_kb_entries_extracted_from_zip ON agent_knowledge_base_entries(extracted_from_zip_id);

-- Create table for tracking file processing jobs
CREATE TABLE IF NOT EXISTS agent_kb_file_processing_jobs (
    job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES basejump.accounts(id) ON DELETE CASCADE,
    
    job_type VARCHAR(50) NOT NULL CHECK (job_type IN ('file_upload', 'zip_extraction', 'git_clone')),
    status VARCHAR(50) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    
    source_info JSONB NOT NULL, -- Contains file path, git URL, etc.
    result_info JSONB DEFAULT '{}', -- Processing results, error messages, etc.
    
    entries_created INTEGER DEFAULT 0,
    total_files INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    
    error_message TEXT
);

-- Create indexes for file processing jobs
CREATE INDEX IF NOT EXISTS idx_agent_kb_jobs_agent_id ON agent_kb_file_processing_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_kb_jobs_status ON agent_kb_file_processing_jobs(status);
CREATE INDEX IF NOT EXISTS idx_agent_kb_jobs_created_at ON agent_kb_file_processing_jobs(created_at);

-- Enable RLS for new table
ALTER TABLE agent_kb_file_processing_jobs ENABLE ROW LEVEL SECURITY;

-- Create RLS policy for file processing jobs
CREATE POLICY agent_kb_jobs_user_access ON agent_kb_file_processing_jobs
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM agents a
            WHERE a.agent_id = agent_kb_file_processing_jobs.agent_id
            AND basejump.has_role_on_account(a.account_id) = true
        )
    );

-- Function to get file processing jobs for an agent
CREATE OR REPLACE FUNCTION get_agent_kb_processing_jobs(
    p_agent_id UUID,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    job_id UUID,
    job_type VARCHAR(50),
    status VARCHAR(50),
    source_info JSONB,
    result_info JSONB,
    entries_created INTEGER,
    total_files INTEGER,
    created_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_message TEXT
)
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        akj.job_id,
        akj.job_type,
        akj.status,
        akj.source_info,
        akj.result_info,
        akj.entries_created,
        akj.total_files,
        akj.created_at,
        akj.completed_at,
        akj.error_message
    FROM agent_kb_file_processing_jobs akj
    WHERE akj.agent_id = p_agent_id
    ORDER BY akj.created_at DESC
    LIMIT p_limit;
END;
$$;

-- Function to create a file processing job
CREATE OR REPLACE FUNCTION create_agent_kb_processing_job(
    p_agent_id UUID,
    p_account_id UUID,
    p_job_type VARCHAR(50),
    p_source_info JSONB
)
RETURNS UUID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
DECLARE
    new_job_id UUID;
BEGIN
    INSERT INTO agent_kb_file_processing_jobs (
        agent_id,
        account_id,
        job_type,
        source_info
    ) VALUES (
        p_agent_id,
        p_account_id,
        p_job_type,
        p_source_info
    ) RETURNING job_id INTO new_job_id;
    
    RETURN new_job_id;
END;
$$;

-- Function to update job status
CREATE OR REPLACE FUNCTION update_agent_kb_job_status(
    p_job_id UUID,
    p_status VARCHAR(50),
    p_result_info JSONB DEFAULT NULL,
    p_entries_created INTEGER DEFAULT NULL,
    p_total_files INTEGER DEFAULT NULL,
    p_error_message TEXT DEFAULT NULL
)
RETURNS VOID
SECURITY DEFINER
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE agent_kb_file_processing_jobs 
    SET 
        status = p_status,
        result_info = COALESCE(p_result_info, result_info),
        entries_created = COALESCE(p_entries_created, entries_created),
        total_files = COALESCE(p_total_files, total_files),
        error_message = p_error_message,
        started_at = CASE WHEN p_status = 'processing' AND started_at IS NULL THEN NOW() ELSE started_at END,
        completed_at = CASE WHEN p_status IN ('completed', 'failed') THEN NOW() ELSE completed_at END
    WHERE job_id = p_job_id;
END;
$$;

-- Grant permissions
GRANT ALL PRIVILEGES ON TABLE agent_kb_file_processing_jobs TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION get_agent_kb_processing_jobs TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_agent_kb_processing_job TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_agent_kb_job_status TO authenticated, service_role;

-- Add comments
COMMENT ON TABLE agent_kb_file_processing_jobs IS 'Tracks file upload, extraction, and git cloning jobs for agent knowledge bases';
COMMENT ON FUNCTION get_agent_kb_processing_jobs IS 'Retrieves processing jobs for an agent';
COMMENT ON FUNCTION create_agent_kb_processing_job IS 'Creates a new file processing job';
COMMENT ON FUNCTION update_agent_kb_job_status IS 'Updates the status and results of a processing job';

COMMIT; 