-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║  project_oauth_credentials                                                  ║
-- ║                                                                            ║
-- ║  Per-project OAuth tokens for external providers (GitHub, GitLab, etc.).   ║
-- ║  Encrypted refresh + access tokens, scoped to a single project so a        ║
-- ║  rotated credential in one project never affects others.                   ║
-- ║                                                                            ║
-- ║  Previously lived in the drizzle migration chain                           ║
-- ║  (0004_add_project_oauth_credentials.sql); moved here so a fresh           ║
-- ║  supabase reset produces a complete schema without needing drizzle.        ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS kortix.project_oauth_credentials (
  credential_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  provider_id       varchar(64) NOT NULL,
  refresh_enc       text NOT NULL,
  access_enc        text NOT NULL,
  expires           bigint NOT NULL,
  oauth_account_id  varchar(255),
  enterprise_url    varchar(255),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_oauth_creds_project
  ON kortix.project_oauth_credentials (project_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_oauth_creds_project_provider
  ON kortix.project_oauth_credentials (project_id, provider_id);
