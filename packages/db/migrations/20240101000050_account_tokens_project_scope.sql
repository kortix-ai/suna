-- Project-scoped CLI tokens.
--
-- `project_id` NULL → user-scoped token (current behavior; CLI on a
-- developer's laptop, can see every project on the user's accounts).
--
-- `project_id` UUID → project-scoped token. The auth middleware
-- enforces that the URL's `:projectId` parameter matches this column;
-- account-level routes (/v1/accounts/*) reject project-scoped tokens.
-- These tokens are auto-minted at session-create time and injected
-- into the sandbox as `KORTIX_TOKEN`.

alter table kortix.account_tokens
  add column if not exists project_id uuid
  references kortix.projects(project_id) on delete cascade;

create index if not exists idx_account_tokens_project
  on kortix.account_tokens(project_id) where project_id is not null;
