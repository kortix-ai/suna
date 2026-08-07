-- Default-private access control for Kortix Apps.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."apps"
  ADD COLUMN "access_mode" varchar(16) DEFAULT 'private' NOT NULL,
  ADD COLUMN "access_password_hash" text,
  ADD COLUMN "access_revision" integer DEFAULT 1 NOT NULL;

ALTER TABLE "kortix"."apps"
  ADD CONSTRAINT "apps_access_revision_check"
  CHECK ("access_revision" > 0) NOT VALID;

ALTER TABLE "kortix"."apps"
  ADD CONSTRAINT "apps_access_mode_check"
  CHECK ("access_mode" IN ('private', 'project', 'restricted', 'public', 'password')) NOT VALID;

CREATE TABLE "kortix"."app_access_grants" (
  "grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "app_id" uuid NOT NULL,
  "principal_type" "kortix"."secret_grant_principal" NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "app_access_grants_app_id_apps_app_id_fk"
    FOREIGN KEY ("app_id") REFERENCES "kortix"."apps"("app_id") ON DELETE CASCADE
);

CREATE INDEX "app_access_grants_app_idx"
  ON "kortix"."app_access_grants" ("app_id");

CREATE UNIQUE INDEX "app_access_grants_unique"
  ON "kortix"."app_access_grants" ("app_id", "principal_type", "principal_id");
