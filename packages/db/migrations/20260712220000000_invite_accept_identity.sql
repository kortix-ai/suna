-- Up Migration
--
-- Add kortix.account_invitations.accepted_by_user_id (uuid, nullable).
--
-- The Drizzle schema (packages/db/src/schema/kortix.ts) gained this column and
-- the API began selecting it — every SELECT against account_invitations now
-- projects `accepted_by_user_id` (Drizzle's `select()` reads the full row),
-- e.g. GET /v1/accounts/:id/invites, GET /v1/account-invites/:id, and the
-- accept/decline handlers. On accept, accounts/invites.ts stamps
-- `accepted_by_user_id = <userId>` alongside `accepted_at` so a re-entry by a
-- different identity can be detected and rejected (409).
--
-- The schema change was committed (and a Drizzle-generated SQL file landed in
-- packages/db/drizzle/) but the corresponding node-pg-migrate migration in
-- packages/db/migrations/ — the ONLY directory the deploy runner applies — was
-- never created. So every environment that ships this code has a kortix.ts that
-- references a column the database does not have, and every invite-listing /
-- invite-accept call 500s with `column "accepted_by_user_id" does not exist`
-- (Better Stack error 97669531…; first seen 2026-07-04, 171 occurrences / 5
-- users as of 2026-07-12).
--
-- This is the missing migration. `ADD COLUMN IF NOT EXISTS` makes it a no-op on
-- fresh builds (the baseline will eventually carry the column too) and a
-- targeted backfill on every already-deployed environment — the same pattern
-- used by 20260622154500000_reconcile_faked_baseline_drift.sql to close
-- code-references-column-prod-lacks drift. The column is nullable: pre-existing
-- accepted invites simply have no recorded acceptor, which the accept handler
-- already tolerates (`if (alreadyAccepted && invite.acceptedByUserId …)`).

ALTER TABLE kortix.account_invitations
  ADD COLUMN IF NOT EXISTS accepted_by_user_id uuid;

-- Down Migration
--
-- Forward-only: dropping the column would re-introduce the 500s the deployable
-- code depends on it not raising. Leave it in place on every environment.
