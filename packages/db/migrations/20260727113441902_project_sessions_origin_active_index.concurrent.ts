// Migration: project_sessions_origin_active_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate`. `pgm.noTransaction()`
// is the supported opt-out. See MIGRATIONS.md "Roll-forward safety".
//
// Why this index: the per-END-USER concurrency cap for Kortix-as-a-Backend. One
// wrapper account fronts many end-users, so the existing account-wide cap lets a
// single end-user consume every slot the whole wrapper has. The new cap COUNTs
// one origin_ref's live sessions, and that COUNT runs on the session-create hot
// path -- unindexed it would scan project_sessions on every backend create.
//
// PARTIAL on (origin_ref is not null AND status in the ACTIVE set): only LIVE
// BACKEND sessions qualify, which is a small slice of the table and empty for
// projects that never use KaaB. The status predicate mirrors
// ACTIVE_SESSION_STATUSES (apps/api/src/projects/lib/session-status.ts) -- if
// that list ever changes, this predicate must change with it or the cap silently
// stops using the index.
//
// Purely additive: a new non-unique btree, no code depends on its absence, and
// CREATE INDEX CONCURRENTLY never blocks writes. IF NOT EXISTS keeps it
// re-runnable after a failed concurrent build (which can leave an INVALID index).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls -- a multi-statement simple query is an
  // implicit transaction block, which silently defeats noTransaction().
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_sessions_account_origin_active
      on kortix.project_sessions (account_id, origin_ref)
      where origin_ref is not null
        and status in ('queued', 'branching', 'provisioning', 'running')
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md).
export const down = false;
