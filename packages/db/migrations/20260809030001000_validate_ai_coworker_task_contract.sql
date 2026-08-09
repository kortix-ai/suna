-- Migration: validate AI coworker task contract constraints.
set lock_timeout = '2s';
set statement_timeout = '5min';

ALTER TABLE kortix.project_tasks
  VALIDATE CONSTRAINT project_tasks_contract_revision_positive;
ALTER TABLE kortix.project_tasks
  VALIDATE CONSTRAINT project_tasks_contract_collections_valid;
