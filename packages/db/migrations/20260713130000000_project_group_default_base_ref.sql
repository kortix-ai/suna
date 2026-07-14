-- Let an attached project group choose the base Git ref inherited by sessions
-- its members start. NULL preserves the project's default_branch behavior.
-- If a member belongs to groups with different non-null refs, application code
-- deterministically falls back to projects.default_branch.

ALTER TABLE kortix.project_group_grants
  ADD COLUMN IF NOT EXISTS default_base_ref text;
