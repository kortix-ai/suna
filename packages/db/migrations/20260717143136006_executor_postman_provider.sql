-- Postman collections and Postman-managed repositories are first-class
-- connector sources. This migration only expands the enum; application rows
-- use the value in later transactions after deployment.
--
-- enum-value-checked: `postman` exists in neither the 2026-07-16 Drizzle
-- rebaseline nor any earlier executor_connector_provider migration, so an
-- environment that faked that baseline cannot have silently skipped this
-- value. This new, post-baseline migration is applied normally in every
-- environment. The isolated Postman E2E database was also queried after
-- migration and returned `postman` from pg_enum before connector insertion.
set statement_timeout = '5s';
set lock_timeout = '1s';
ALTER TYPE "kortix"."executor_connector_provider" ADD VALUE IF NOT EXISTS 'postman' BEFORE 'graphql';
