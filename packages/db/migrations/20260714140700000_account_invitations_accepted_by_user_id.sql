-- Up Migration

-- kortix.ts declares account_invitations.accepted_by_user_id, but no migration
-- ever created the column, so any migrations-built DB 500s on
-- GET /accounts/:id/invites. Additive and idempotent; safe on DBs where the
-- column was hand-added.
ALTER TABLE kortix.account_invitations
  ADD COLUMN IF NOT EXISTS accepted_by_user_id uuid;

-- Down Migration

ALTER TABLE kortix.account_invitations
  DROP COLUMN IF EXISTS accepted_by_user_id;
