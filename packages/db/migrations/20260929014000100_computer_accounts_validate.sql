-- Migration: computer_accounts_validate
--
-- Step 2 for 20260928210714434_computer_accounts.sql, which added the
-- connector_connections.tunnel_id foreign key NOT VALID. The constraint already
-- governs every INSERT and UPDATE; this marks the pre-existing rows as checked.
-- Every pre-existing row has tunnel_id NULL, so validation cannot fail.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on
-- kortix.connector_connections (and ROW SHARE on kortix.tunnel_connections).
-- It blocks no read and no ordinary write, for one scan of the table.
--
-- mixed-version-safe: adds no column, drops nothing, renames nothing.
--
-- backfill-safe: no DML.

set lock_timeout = '3s';
set statement_timeout = '300s';

ALTER TABLE "kortix"."connector_connections"
  VALIDATE CONSTRAINT "connector_connections_tunnel_id_tunnel_connections_tunnel_id_fk";
