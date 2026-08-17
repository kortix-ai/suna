-- Migration: widen_app_deployment_hosting_type
set lock_timeout = '2s';
set statement_timeout = '30s';

-- `managed_container` contains 17 characters. Increasing a varchar limit is a
-- metadata-only change and preserves sandbox writes from older API versions.
-- mixed-version-safe: both old and new API versions write values accepted by varchar(24).
ALTER TABLE "kortix"."app_deployments"
  -- squawk-ignore changing-column-type
  ALTER COLUMN "hosting_type" TYPE varchar(24);
