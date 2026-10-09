-- Migration: validate_apps_kinds
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the three CHECKs 20261009115630597_apps_kinds added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and writes continue.
-- Every stored row passes: `kind` is the constant default 'web' on every
-- existing App, and every stored source_kind / hosting_type is one the old,
-- narrower constraints already accepted.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."apps" VALIDATE CONSTRAINT "apps_kind_check";
ALTER TABLE "kortix"."app_deployments" VALIDATE CONSTRAINT "app_deployments_source_kind_check";
ALTER TABLE "kortix"."app_deployments" VALIDATE CONSTRAINT "app_deployments_hosting_type_check";
