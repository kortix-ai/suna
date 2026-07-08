-- Up Migration
--
-- Sidebar session folders. Users organize a project's sessions into named
-- folders; a session lives in at most one folder (project_sessions.folder_id,
-- NULL = unfiled). Auto-folders (Slack / Email / Scheduled / Webhooks) are
-- virtual — derived from project_sessions.metadata.source client-side — and
-- have no rows here. Folder visibility reuses project_session_visibility:
--   'private' = only the creator sees the folder;
--   'project' = every member sees it AND sessions inside inherit project-wide
--               visibility (folder sharing by inheritance).
-- Deleting a folder unfiles its sessions (SET NULL), never deletes them.

CREATE TABLE IF NOT EXISTS "kortix"."session_folders" (
  "folder_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "kortix"."projects"("project_id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "visibility" "kortix"."project_session_visibility" NOT NULL DEFAULT 'private',
  "position" integer NOT NULL DEFAULT 0,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_session_folders_project" ON "kortix"."session_folders" ("project_id");

CREATE INDEX IF NOT EXISTS "idx_session_folders_account" ON "kortix"."session_folders" ("account_id");

ALTER TABLE "kortix"."project_sessions"
  ADD COLUMN IF NOT EXISTS "folder_id" uuid REFERENCES "kortix"."session_folders"("folder_id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_project_sessions_folder" ON "kortix"."project_sessions" ("folder_id") WHERE "folder_id" IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS "kortix"."idx_project_sessions_folder";
ALTER TABLE "kortix"."project_sessions" DROP COLUMN IF EXISTS "folder_id";
DROP TABLE IF EXISTS "kortix"."session_folders";
