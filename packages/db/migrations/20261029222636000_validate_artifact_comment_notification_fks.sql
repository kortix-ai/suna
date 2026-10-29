-- Validate only the two new nullable references, after their supporting indexes exist.
-- Old notification rows have NULL in both newly added columns. The NOT VALID FKs
-- enforce all subsequent values, so no historical reconciliation is required.
set lock_timeout = '2s';
set statement_timeout = '30s';
ALTER TABLE kortix.notifications VALIDATE CONSTRAINT notifications_artifact_fk;
ALTER TABLE kortix.notifications VALIDATE CONSTRAINT notifications_artifact_thread_fk;
