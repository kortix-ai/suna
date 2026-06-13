-- Adds the `built_from_commit` column to kortix.sandbox_templates.
--
-- The Drizzle schema (packages/db/src/schema/kortix.ts) declares this column
-- (`builtFromCommit: text('built_from_commit')`) but the original table
-- migration (00000000000095_sandbox_templates.sql) never created it, so the
-- snapshot/template queries — and therefore session-sandbox provisioning —
-- failed with: column "built_from_commit" does not exist (42703).
--
-- Git commit the template's Dockerfile was last built from. NULL for the
-- platform default (constant Dockerfile) and image-only templates.

ALTER TABLE kortix.sandbox_templates
  ADD COLUMN IF NOT EXISTS built_from_commit TEXT;
