// Migration: project_sessions_project_origin_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate`. `pgm.noTransaction()`
// is the supported opt-out. See MIGRATIONS.md "Roll-forward safety".
//
// Why this index: GET /projects/:id/sessions now accepts ?end_user_ref=, so a
// Kortix-as-a-Backend wrapper can ask for one end-user's sessions instead of
// pulling every session in the project and filtering client-side. That filter
// spans ALL statuses (a wrapper wants the finished ones too), so the existing
// idx_project_sessions_account_origin_active cannot serve it -- that one is
// partial on the four LIVE statuses. Without this index the filtered list
// degrades to "scan every session in the project", which is exactly the shape
// that gets slow first for the biggest wrapper.
//
// PARTIAL on (origin_ref is not null): only backend sessions carry an
// end-user handle, so the index stays empty for projects that never use KaaB.
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
    create index concurrently if not exists idx_project_sessions_project_origin
      on kortix.project_sessions (project_id, origin_ref)
      where origin_ref is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md).
export const down = false;
