-- Up Migration
--
-- Folder sharing joins the common team-share model. A `restricted` folder's
-- allow-list of members/groups lives here, mirroring project_session_grants.
-- Sessions inside a shared folder inherit the folder's audience.

CREATE TABLE IF NOT EXISTS "kortix"."session_folder_grants" (
  "grant_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "folder_id" uuid NOT NULL REFERENCES "kortix"."session_folders"("folder_id") ON DELETE CASCADE,
  "principal_type" "kortix"."secret_grant_principal" NOT NULL,
  "principal_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_session_folder_grants_folder" ON "kortix"."session_folder_grants" ("folder_id");

CREATE UNIQUE INDEX IF NOT EXISTS "idx_session_folder_grants_unique"
  ON "kortix"."session_folder_grants" ("folder_id", "principal_type", "principal_id");

-- Down Migration

DROP TABLE IF EXISTS "kortix"."session_folder_grants";
