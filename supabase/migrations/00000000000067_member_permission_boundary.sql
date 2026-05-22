-- Permission boundary on account_members: AWS-style max envelope of
-- action prefixes a member can ever be granted. NULL = no boundary.
-- Engine clips at evaluation: if the boundary is set and the action's
-- prefix isn't in the list, the call is denied even when explicit
-- allow-policies cover it. Super-admins bypass.
--
-- Shape: { "allow_action_prefixes": ["project.", "sandbox.read"] }

ALTER TABLE "kortix"."account_members"
  ADD COLUMN IF NOT EXISTS "permission_boundary" jsonb;
