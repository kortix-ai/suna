-- Migration: project_secret_tombstones
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules-checklist).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- KRTX-2056: tombstones for deleted shared project secrets, keyed by secret
-- NAME. Setup-link tokens are stateless and carry only their mint time, so
-- without this state a submit on a link minted before `kortix secrets unset`
-- re-created the secret. The unset route writes a row in the delete's
-- transaction; the public intake routes reject when a tombstone for a
-- requested name is newer than the token's `iat`.
--
-- Purely additive (a brand-new table): no existing table, column, constraint
-- or index is touched, so no expand/contract or mixed-version annotation
-- applies. The FK target (kortix.projects) is indexed by its primary key and
-- the new table's own primary key leads with project_id, so both directions
-- of the reference are covered without a separate index.
create table kortix.project_secret_tombstones (
  project_id uuid not null references kortix.projects (project_id) on delete cascade,
  name varchar(64) not null,
  deleted_at timestamptz not null default now(),
  primary key (project_id, name)
);
