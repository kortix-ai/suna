-- Migration: project_members_primary_key
--
-- kortix.project_members has shipped since the baseline with NO PRIMARY KEY.
-- Uniqueness rested entirely on idx_project_members_project_user, which is also
-- the ON CONFLICT inference target of every upsert on the table — so the one
-- index guaranteeing correctness is the one an unrelated cleanup is most likely
-- to drop, and dropping it 42P10s every write path (the exact failure
-- account_members hit; see the comment at packages/db/src/schema/kortix.ts:203).
--
-- Promotes the unique index built CONCURRENTLY by
-- 20260819015724600_rbac_canonical_indexes.concurrent.ts into the real PRIMARY
-- KEY. ADD CONSTRAINT ... USING INDEX does a catalog update only: no table
-- scan, no index build, ACCESS EXCLUSIVE held for microseconds. The constraint
-- name equals the index name, so nothing is renamed.
--
-- mixed-version-safe: ADDS a constraint, removes nothing. project_id and user_id
-- are already NOT NULL and already unique together, so no existing row can
-- violate it and no old code path can produce one that would. The pre-existing
-- idx_project_members_project_user UNIQUE index is deliberately left in place —
-- old and new code both keep their ON CONFLICT (project_id, user_id) target.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_members
  ADD CONSTRAINT project_members_project_id_user_id_pk
  PRIMARY KEY USING INDEX project_members_project_id_user_id_pk;
