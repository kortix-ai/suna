-- Migration: oauth_access_tokens_bound_workspace
--
-- Workspaces auth (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C4a). The OAuth consent screen names one workspace; the access token it
-- issues is bound to it and the credential fence judges it like a workspace key
-- (middleware/workspace-binding.ts). NULL = an unbound token (every token issued
-- before this column, and a consent that names no workspace): it acts as the
-- person in every workspace, as before.
--
-- Not workspace_id: that M7 column is stamped from account_id by a trigger for
-- every row, bound or not; bound_workspace_id is the consent's choice.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE on oauth_access_tokens for a moment. One hot table, one
-- file. 3s lock_timeout: on 55P03 the file rolls back as a whole: find the
-- holder in pg_stat_activity, rerun the migrate job. Never raise the timeout.
--
-- Mixed-version deploy: the old image never names the column; an old pod
-- treats a bound token as unbound for the rollout window (minutes), i.e. as the
-- person, which is what every OAuth token was before.
--
-- ROLL BACK: no down migration (repo policy). The column can stay.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."oauth_access_tokens" ADD COLUMN IF NOT EXISTS "bound_workspace_id" uuid;

COMMENT ON COLUMN "kortix"."oauth_access_tokens"."bound_workspace_id" IS
  'The workspace the consent bound this token to; the credential fence judges it like a workspace key. NULL = unbound (acts as the person).';
