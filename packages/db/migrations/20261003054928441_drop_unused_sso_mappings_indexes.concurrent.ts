// Migration: drop_unused_sso_mappings_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two `kortix.account_sso_group_mappings` indexes the Supabase
// performance advisor reports as unused (lint `unused_index`, observed
// 2026-10-02 and 2026-10-03):
//
//   idx_account_sso_mappings_provider  (sso_provider_id)   0 scans, 8 KB
//   idx_account_sso_mappings_group     (group_id)          0 scans, 8 KB
//
// Prod `pg_stat_user_indexes.idx_scan` is 0 for both, and no query on the
// table uses either column: every read and write in
// `apps/api/src/repositories/sso.ts` predicates on (account_id,
// claim_value[, mapping_id]) and is served by the kept unique index
// `idx_account_sso_mappings_claim` (226,585 scans) or the primary key. Each
// dropped index costs one index write on every mapping INSERT/UPDATE/DELETE.
//
// The dropped columns still carry ON DELETE CASCADE foreign keys. Without
// the indexes, deleting an account group or SSO provider resolves the
// cascade through a seq scan — fine for a per-account config table
// (prod: 0 rows; the advisor's unindexed_foreign_keys lint does not flag
// either column, and an index that no read path uses is pure write cost).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer, and it only unlinks files (no heap rewrite). It cannot run
// in a transaction, hence this .concurrent.ts file (MIGRATIONS.md
// "Roll-forward safety"). lock_timeout is 180s: the statement waits for
// transactions that began before it (learnings 2026-08-19), and that wait
// blocks nobody.
//
// Two statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They
// stay separate pgm.sql() calls: a multi-statement string is an implicit
// transaction and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No code names either index (Postgres
// never plans an index by name; a git grep of both names over the repo finds
// only this migration and the Drizzle schema comment) and no constraint, ON
// CONFLICT clause, view or policy depends on them (both are plain non-unique
// btree indexes; verified via pg_depend on prod). A still-running older API
// image plans the same queries — every query on this table keeps the kept
// unique index or the primary key, so the drop cannot change a query plan's
// availability.
export const up = (pgm) => {
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_sso_mappings_provider`);
  pgm.sql(`drop index concurrently if exists kortix.idx_account_sso_mappings_group`);
};

// Forward-only. Re-creating unread indexes would re-impose their write cost.
export const down = false;
