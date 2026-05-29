-- Sandbox templates: the durable identity for "what kind of sandbox a session
-- can boot from." Replaces the in-code/TOML-only model.
--
-- One row per template. Platform-shared templates have project_id IS NULL +
-- is_shared=true and any project can boot from them. Per-project custom
-- templates have project_id set and source='ui' (or 'toml' for TOML-synced).
--
-- The actual snapshot image is built by a provider adapter (Daytona today).
-- `provider_state` mirrors the live registry state for the UI; session boot
-- still asks the provider directly, so cache drift is harmless.

CREATE TABLE kortix.sandbox_templates (
  template_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  account_id UUID REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'toml',
  provider TEXT NOT NULL DEFAULT 'daytona',
  image TEXT,
  dockerfile_path TEXT,
  entrypoint TEXT,
  cpu INTEGER,
  memory_gb INTEGER,
  disk_gb INTEGER,
  content_hash TEXT,
  provider_snapshot_name TEXT,
  provider_state TEXT NOT NULL DEFAULT 'missing',
  last_built_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sandbox_templates_project ON kortix.sandbox_templates(project_id);
CREATE INDEX idx_sandbox_templates_shared ON kortix.sandbox_templates(is_shared);
CREATE UNIQUE INDEX idx_sandbox_templates_project_slug
  ON kortix.sandbox_templates(project_id, slug);

-- Seed the platform default. project_id NULL, is_shared=true, no image and
-- no dockerfile_path → the provider adapter knows this is "the platform
-- runtime layer on top of Ubuntu." Any project can boot from it.
INSERT INTO kortix.sandbox_templates
  (project_id, account_id, slug, name, is_shared, source, provider,
   cpu, memory_gb, disk_gb, provider_state)
VALUES
  (NULL, NULL, 'default', 'Default', TRUE, 'platform', 'daytona',
   2, 4, 20, 'missing');
