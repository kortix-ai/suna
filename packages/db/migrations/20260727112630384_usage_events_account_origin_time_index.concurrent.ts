// Migration: usage_events_account_origin_time_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE INDEX CONCURRENTLY cannot run inside a
// transaction, and every plain .sql migration here runs inside the single batch
// transaction node-pg-migrate wraps around `pnpm migrate`. `pgm.noTransaction()`
// is the supported opt-out. See MIGRATIONS.md "Roll-forward safety".
//
// Why this index: per-end-user metering for Kortix-as-a-Backend. It serves both
// "spend for origin_ref X between two timestamps" and the group_by=origin_ref
// rollup on GET /v1/usage, which are otherwise a full scan of the billing ledger.
// Leading account_id keeps it tenant-scoped (every usage read is already scoped
// that way); created_at trails so the same index covers the time window.
//
// PARTIAL on `origin_ref is not null`: only backend-origin sessions carry an
// origin_ref, so the overwhelming majority of rows never enter this index --
// it stays small and the write cost on ordinary (non-KaaB) spend is nil.
//
// Purely additive: a new non-unique btree. No code depends on its absence and
// CREATE INDEX CONCURRENTLY never blocks writes, so it is safe to run ahead of
// the read path that benefits from it. IF NOT EXISTS keeps it re-runnable after
// a failed concurrent build (which can leave an INVALID index behind).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string -- a
  // multi-statement simple query is an implicit transaction block, which
  // silently defeats noTransaction() for CONCURRENTLY.
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_usage_events_account_origin_time
      on kortix.usage_events (account_id, origin_ref, created_at)
      where origin_ref is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md).
export const down = false;
