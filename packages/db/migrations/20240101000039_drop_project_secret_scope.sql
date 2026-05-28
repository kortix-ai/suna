-- Simplify project secrets: flat key-value only.
-- Drops the scope concept (runtime / llm_provider / connector).
-- Any rows previously stored as 'connector' scope held dead-code OAuth
-- token blobs that were never read back, so they're discarded too.

delete from kortix.project_secrets where scope <> 'runtime';

drop index if exists kortix.idx_project_secrets_scope;

alter table kortix.project_secrets drop column if exists scope;

drop type if exists kortix.project_secret_scope;
