-- Up Migration
--
-- Caller-supplied dedupe token for POST /v1/projects/provision.
--
-- WHY. That route mints a brand-new managed repo on every call and its only
-- guard was `enforceProjectQuota` — a straight count. On any account whose
-- quota permits two or more projects, a retry after a lost response (a reload,
-- a second onboarding tab, an aborted request) created a genuine duplicate
-- project WITH ITS OWN upstream GitHub repo. Users hit this as duplicate
-- "My First Project" rows.
--
-- The route now reads `idempotency_key` from the request body and looks it up
-- BEFORE `backend.createRepo`, so a repeat returns the project the first call
-- created and creates nothing upstream. Persisting the key on the project row
-- (rather than in process memory) is what makes the dedupe survive a process
-- restart and a request landing on a different API replica.
--
-- SHAPE. Nullable, no default, no backfill: every pre-existing project and
-- every project created by any other route (BYO-repo link, /create-repo, the
-- CLI) legitimately has no key. Adding a nullable column with no default is
-- metadata-only — Postgres does not rewrite the table.
--
-- The unique constraint that makes this a real guarantee (and not a
-- best-effort pre-check racing itself) is the partial unique index built
-- CONCURRENTLY in the companion `.concurrent.ts` migration that follows this
-- one. It cannot live here: every plain .sql migration in this repo runs
-- inside node-pg-migrate's single batch transaction, and CONCURRENTLY cannot.
-- Ordering matters — this file adds the column, that file indexes it.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- MIXED-VERSION BEHAVIOUR. Purely additive and nullable. The currently
-- deployed API neither reads nor writes this column, so old pods keep
-- inserting projects with a NULL key, which the partial index does not
-- constrain at all. New pods that write a key are constrained only against
-- other rows that also carry one. Nothing narrows, nothing drops, and a
-- rollback to the previous API is safe with the column left in place.

ALTER TABLE "kortix"."projects"
  ADD COLUMN "idempotency_key" text;

COMMENT ON COLUMN "kortix"."projects"."idempotency_key" IS
  'Caller-supplied dedupe token for POST /v1/projects/provision. NULL for projects created by any other route. Unique per account among non-NULL values (idx_projects_account_idempotency_key).';
