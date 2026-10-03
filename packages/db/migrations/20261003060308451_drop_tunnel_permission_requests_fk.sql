-- Migration: drop_tunnel_permission_requests_fk
--
-- Drops the only foreign key on kortix.tunnel_permission_requests
-- (tunnel_id -> kortix.tunnel_connections.tunnel_id, ON DELETE CASCADE) in the
-- same change that drops the table's three never-scanned secondary indexes
-- (the next migration). No application code reads or writes this table: a
-- search of apps/, packages/ and infra/ finds zero references outside the
-- Drizzle schema and the migrations, and pg_stat_user_indexes on prod shows
-- idx_scan = 0 on every index of the table, the primary key included. The
-- Supabase performance advisor reports all three secondary indexes as
-- unused_index (KRTX-1211).
--
-- The FK is what would undo that cleanup: its only covering index is
-- idx_tunnel_perm_requests_tunnel, so dropping the indexes while keeping the
-- FK makes the advisor report unindexed_foreign_keys on the same table, and
-- re-adding an index on an unread table flips straight back to unused_index.
-- With no reader and no writer, the FK protects nothing; the end state below
-- (primary key only) is the one stable, advisor-clean shape.
--
-- mixed-version-safe: no still-running app version can reference this FK --
-- no code references the table at all (see above), no view selects from it
-- and no RLS policy is defined on it (verified via pg_views, pg_policies and
-- pg_depend on the prod database, read-only, 2026-10-03). The only behavior
-- change is for DELETEs on kortix.tunnel_connections: they stop cascading
-- into this table, whose 27 legacy rows simply stay. Rollback, if the table
-- ever gains a reader again:
--   alter table kortix.tunnel_permission_requests
--     add constraint tunnel_permission_requests_tunnel_id_tunnel_connections_tunnel_
--     foreign key (tunnel_id) references kortix.tunnel_connections(tunnel_id)
--     on delete cascade not valid;  -- then validate constraint
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.tunnel_permission_requests
  DROP CONSTRAINT tunnel_permission_requests_tunnel_id_tunnel_connections_tunnel_;
