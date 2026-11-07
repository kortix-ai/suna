-- Migration: account_tokens_created_by
--
-- Workspaces auth, one API keys concept (design:
-- .agents/skills/learnings/work/workspaces/design.md §3.2 C4b). One nullable
-- column on account_tokens:
--   created_by  the person who minted the key. A key that acts as an agent or
--               a bot stores that service account in user_id (the principal)
--               and the person here, so the key survives the person leaving
--               the workspace and the list still names who created it.
--               NULL = user_id minted it, as every key minted before.
--
-- Locks: ADD COLUMN (nullable, no default: catalog-only, no rewrite) takes
-- ACCESS EXCLUSIVE on account_tokens for a moment. account_tokens is read on
-- every PAT request: one hot table, one file. 3s lock_timeout: on 55P03 the
-- file rolls back as a whole: find the holder in pg_stat_activity, rerun the
-- migrate job. Never raise the timeout. IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names the column. An old pod
-- authorizes an agent or bot key through the same service-account columns it
-- already reads (service_account_id, agent_grant). Every existing row stays NULL.
--
-- ROLL BACK: no down migration (repo policy). The column can stay: nothing but
-- the new image reads it.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."account_tokens" ADD COLUMN IF NOT EXISTS "created_by" uuid;

COMMENT ON COLUMN "kortix"."account_tokens"."created_by" IS
  'The person who minted the key when user_id is a service account (an agent or bot key). NULL = user_id minted it.';
