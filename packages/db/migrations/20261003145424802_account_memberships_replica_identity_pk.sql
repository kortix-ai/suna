-- Migration: account_memberships_replica_identity_pk
--
-- Re-points kortix.account_memberships' logical-replication identity to the
-- surviving primary-key index account_members_pkey, immediately before
-- 20261003145424803_drop_duplicate_account_memberships_index drops the index
-- it was on (the Supabase advisor's duplicate of the PK).
--
-- Why: scripts/prod-us-east-2/db-sync.sh once set
-- `REPLICA IDENTITY USING INDEX idx_account_members_user_account` on the table
-- (2026-07-25, under its pre-rename name account_members; the 2026-08-19 RBAC
-- cutover renamed the table and the flag persists). Dropping a table's
-- identity index does not fall back to the primary key: PostgreSQL clears the
-- index's indisreplident flag and leaves the table's relreplident = 'i' with
-- no identity index behind it (only ALTER TABLE rewrites relreplident), so
-- UPDATE/DELETE changes carry no old key. No subscriber reads that today —
-- the lane's publication and slot were dropped 2026-08-08 — and on revival
-- the stale db-sync.sh line fails loudly at its own step; re-point that line
-- to account_members_pkey as part of revival (refresh-replication.sh's unsafe
-- check looks for 'n' or a PK-less 'd', not a stale 'i', so the re-point here
-- is what actually keeps a revived lane clean). Re-pointing first leaves every
-- environment with a valid identity and nothing referencing the dropped
-- index. The identity stays the same (user_id, account_id) pair, so
-- replication semantics are unchanged.
--
-- Plain .sql on purpose: this ALTER takes a brief ACCESS EXCLUSIVE metadata
-- lock, so it gets the house 2s lock_timeout (fail fast rather than queue
-- writers) — it must not ride the .concurrent.ts hatch, whose lint floor
-- forces a 180s budget on every statement in the file. Every environment has
-- account_members_pkey before this file runs (baseline; prod's was built and
-- attached by 20260925023835081/20260925023835781, which sort earlier), and
-- the index is unique, immediate, non-partial and non-expression, on
-- NOT NULL columns — what REPLICA IDENTITY USING INDEX requires.
--
-- mixed-version-safe: metadata-only. The identity is the same (user_id,
-- account_id) pair before and after, no application code reads relreplident,
-- and the one runbook reference (the stale db-sync.sh line above) fails
-- loudly at its own step on any revival, which rebuilds replication from
-- scratch anyway.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table kortix.account_memberships
  replica identity using index account_members_pkey;
