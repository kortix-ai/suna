set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.job_queue VALIDATE CONSTRAINT job_queue_artifact_fk;
ALTER TABLE kortix.session_lifecycle_commands VALIDATE CONSTRAINT session_lifecycle_commands_artifact_fk;
