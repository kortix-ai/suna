-- Migration: validate_trigger_session_access
--
-- Validation scans the bounded trigger runtime catalog without blocking
-- normal reads or writes. The column default satisfies every existing row.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_trigger_runtime
  VALIDATE CONSTRAINT project_trigger_runtime_session_access_mode_check;
