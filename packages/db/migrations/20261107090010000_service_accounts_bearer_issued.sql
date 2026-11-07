-- Migration: service_accounts_bearer_issued
--
-- Workspaces auth, one API keys concept (design:
-- .agents/skills/learnings/work/workspaces/design.md §3.2 C4b). One column on
-- service_accounts:
--   bearer_issued  false for a bot created from Workspace settings › API keys:
--                  its own kortix_sa_ bearer was never handed out (the plaintext
--                  is discarded, as for an agent identity), and its credentials
--                  are workspace keys in account_tokens. true for every row
--                  before, whose bearer is the credential, so the key list shows
--                  that bearer and the auth middleware keeps accepting it.
--
-- Locks: ADD COLUMN ... NOT NULL DEFAULT true with a constant default is
-- catalog-only on Postgres 11+ (no rewrite): ACCESS EXCLUSIVE on
-- service_accounts for a moment. service_accounts is read on every agent
-- session request (the activation probe): one table, one file. 3s
-- lock_timeout: on 55P03 the file rolls back as a whole; rerun the migrate job.
-- IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names the column; every row it
-- inserts gets true, which is the old meaning.
--
-- ROLL BACK: no down migration (repo policy). The column can stay.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."service_accounts"
  ADD COLUMN IF NOT EXISTS "bearer_issued" boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN "kortix"."service_accounts"."bearer_issued" IS
  'false = a bot whose kortix_sa_ bearer was never handed out; its credentials are workspace keys in account_tokens.';
