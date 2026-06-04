ALTER TABLE kortix.sandbox_templates
  ADD COLUMN IF NOT EXISTS built_from_commit TEXT;
