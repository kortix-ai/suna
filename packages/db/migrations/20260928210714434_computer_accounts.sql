-- Migration: computer_accounts
--
-- Kortix Local Mode: a paired computer becomes an ACCOUNT (a
-- `connector_connections` row) on the project's `computer` connector, owned
-- by one member (private) or by the project (shared), exactly like a personal
-- Gmail account. Three nullable columns carry that model:
--
--   tunnel_connections.owner_user_id       the human who paired the machine
--   connector_connections.tunnel_id        the machine a computer account reaches
--   tunnel_device_auth_requests.project_id the project a pairing asked to join
--
-- All three are nullable with no default: a catalog-only change, no rewrite.
-- The foreign key is added NOT VALID (no scan) and validated by
-- 20260928210714500_computer_accounts_validate.sql. Every existing row has
-- tunnel_id NULL, so validation cannot fail. The indexes are built by the two
-- following .concurrent.ts files; the data backfill runs after them in
-- 20260928210716000_computer_accounts_backfill.concurrent.ts.
--
-- mixed-version-safe: adds nullable columns and one NOT VALID foreign key.
-- Drops nothing, renames nothing. Old API versions never read or write the new
-- columns, and an INSERT that omits them stores NULL, which the constraint
-- accepts.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."connector_connections" ADD COLUMN "tunnel_id" uuid;
ALTER TABLE "kortix"."tunnel_connections" ADD COLUMN "owner_user_id" uuid;
ALTER TABLE "kortix"."tunnel_device_auth_requests" ADD COLUMN "project_id" uuid;
ALTER TABLE "kortix"."connector_connections"
  ADD CONSTRAINT "connector_connections_tunnel_id_tunnel_connections_tunnel_id_fk"
  FOREIGN KEY ("tunnel_id") REFERENCES "kortix"."tunnel_connections"("tunnel_id")
  ON DELETE set null ON UPDATE no action
  NOT VALID;
