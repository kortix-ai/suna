-- Validate App access checks without blocking normal writes.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."apps"
  VALIDATE CONSTRAINT "apps_access_revision_check";

ALTER TABLE "kortix"."apps"
  VALIDATE CONSTRAINT "apps_access_mode_check";
