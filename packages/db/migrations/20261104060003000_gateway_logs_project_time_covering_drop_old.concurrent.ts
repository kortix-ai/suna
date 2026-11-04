// Migration: gateway_logs_project_time_covering_drop_old  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The CONCURRENTLY escape hatch: DROP INDEX CONCURRENTLY cannot run inside a
// transaction. See
// 20261104060001000_gateway_logs_project_time_covering_llm.concurrent.ts for
// the full house rules for this file class.

export const shorthands = undefined;

// KRTX-4023, step 2 of the replace dance started in 20261104060001000: the
// replacement covering index (same (project_id, created_at) keys, INCLUDE
// extended with the llm-value, served-model and account/session columns) is
// built; the old index is now dominated by it — every plan it could serve,
// the replacement serves index-only over a strict superset of its columns —
// and keeping both doubles the write amplification on the hottest write path
// in the database (one index entry per gateway request).
//
// mixed-version-safe: the replacement index was built first
// (20261104060001000), so at every moment from here on an index carrying at
// least the old column set exists. The planner matches indexes by definition,
// never by name, and no code references index names, so old and new code are
// served identically before and after this drop.

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per call: a multi-statement string is an implicit
  // transaction block, which defeats noTransaction() (see the sibling
  // migration's header).
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_gateway_logs_project_time_covering`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
