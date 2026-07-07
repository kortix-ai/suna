CREATE INDEX IF NOT EXISTS idx_executor_executions_project_session_created
  ON kortix.executor_executions (project_id, session_id, created_at DESC);
