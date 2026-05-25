-- Cross-account sharing via "external" account_members rows. The engine
-- treats them identically to regular members (same policy + group
-- lookups), but the UI surfaces them separately and they carry an
-- optional auto-revoke timestamp + grant note.

ALTER TABLE "kortix"."account_members"
  ADD COLUMN IF NOT EXISTS "is_external"                  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "external_grant_expires_at"    timestamptz,
  ADD COLUMN IF NOT EXISTS "external_granted_by"          uuid,
  ADD COLUMN IF NOT EXISTS "external_note"                text;
