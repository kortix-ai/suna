// Migration: admin_analytics_ledger_time_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Adds kortix.credit_ledger (created_at) for the admin credit-burn dashboard
// (apps/api/src/admin/analytics.ts -> GET /v1/admin/analytics/usage).
//
// WHY: that route sums debits across a trailing 1-90 day window for ALL
// accounts. credit_ledger already carries thirteen indexes, but every
// time-ordered one leads with account_id
// (idx_credit_ledger_account_id, idx_credit_ledger_account_created_debit,
// idx_credit_ledger_account_type_created_desc, idx_credit_ledger_recent_ops),
// which a global `created_at >= $1` predicate cannot use. credit_ledger is the
// largest table this dashboard touches -- one row per debit, grant and refund --
// so a repeated sequential scan is the single worst query on the page.
//
// NOT partial on `amount_precise < 0` even though the route only reads debits:
// drizzle sends that bound as a parameter, and the planner can only prove a
// partial-index predicate against a folded constant. A predicate the planner
// cannot prove yields an index it will never choose. Unconditional keeps it
// usable, and created_at is monotonic so inserts stay on the right-most leaf.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  pgm.sql(`set lock_timeout = '2s'`);
  pgm.sql(`
    create index concurrently if not exists idx_credit_ledger_created_at
      on kortix.credit_ledger (created_at)
  `);
};

// Purely additive index. No down migration (repo policy -- see MIGRATIONS.md).
export const down = false;
