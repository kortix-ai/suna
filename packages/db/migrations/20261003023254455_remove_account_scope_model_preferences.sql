-- Migration: remove_account_scope_model_preferences
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Remove the account-level model default. The gateway now resolves the synthetic
-- `auto` model through agent -> project -> platform only (the 'account' scope is
-- gone from @kortix/sdk and apps/api in this same change). This deletes the
-- orphaned account-scope rows so a stale account pin can never resolve again.
--
-- No DDL: the `account_model_preferences` table and every column stay. The table
-- keeps serving scope='agent' and scope='project' rows. Only scope='account'
-- rows are removed, so re-running this migration is a no-op (idempotent DELETE).
--
-- Not a schema change, so no mixed-version/expand-contract concern: migrations
-- run before the new code deploys, and old code that still reads an account pin
-- simply finds none and falls through to the project/platform default — a
-- graceful degrade, never an error.
--
-- backfill-safe: kortix.account_model_preferences holds at most one
-- scope='account' row per account (tens of rows); the DELETE touches only those
-- rows, runs no DDL, and finishes in milliseconds.
DELETE FROM "kortix"."account_model_preferences" WHERE scope = 'account';
