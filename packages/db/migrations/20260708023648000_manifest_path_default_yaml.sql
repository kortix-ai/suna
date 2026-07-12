-- v2 manifests are YAML-only (kortix.yaml); TOML (kortix.toml) is the v1 legacy
-- format, still resolved as a read fallback. New projects default to the YAML
-- manifest path. Existing rows keep their stored path — resolution prefers a
-- sibling kortix.yaml regardless, so v1 repos keep working unchanged.
ALTER TABLE kortix.projects ALTER COLUMN manifest_path SET DEFAULT 'kortix.yaml';
