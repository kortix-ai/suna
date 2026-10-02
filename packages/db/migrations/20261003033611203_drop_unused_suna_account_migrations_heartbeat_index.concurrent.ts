// Migration: drop_unused_suna_account_migrations_heartbeat_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the one index on kortix.suna_account_migrations that no read path
// can use. Prod pg_stat_user_indexes (2026-10-02, read-only;
// pg_stat_database.stats_reset is NULL, so idx_scan is lifetime):
//
//   idx_suna_account_migrations_status     idx_scan 287,225  (kept)
//   idx_suna_account_migrations_account        idx_scan  8,791  (kept)
//   idx_suna_account_migrations_heartbeat      idx_scan      0  (dropped)
//   suna_account_migrations_pkey               idx_scan  2,888  (kept)
//
// The composite (status, heartbeat_at) never serves a query. The resume
// worker tick (apps/api/src/projects/suna-migration/suna-migration-worker.ts)
// filters status IN ('planned','running') AND (heartbeat_at IS NULL OR
// heartbeat_at < staleBefore): the OR/IS-NULL arm is not an index condition
// on the second column, and EXPLAIN on prod plans
// idx_suna_account_migrations_status for the status arm with the heartbeat
// predicate as a Filter. The table is 327 rows / 416 kB; the composite's
// only real cost is its write on every migration row.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader,
// no writer, and unlinks files without a heap rewrite. It cannot run in a
// transaction, hence the .concurrent.ts escape hatch (MIGRATIONS.md
// "Roll-forward safety"). lock_timeout is 180s: the statement waits for
// transactions that began before it, and that wait blocks nobody
// (learnings 2026-08-19).
//
// One statement, one pgm.sql() call: a multi-statement string is an implicit
// transaction and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: no query benefits from this index (idx_scan = 0, and
// EXPLAIN plans the status index for the one status+heartbeat query), so a
// still-running older API image plans the same queries after the drop. The
// three read paths keep their serving indexes: account reads use
// idx_suna_account_migrations_account, the worker tick uses
// idx_suna_account_migrations_status. Reversibility: `create index
// concurrently idx_suna_account_migrations_heartbeat on
// kortix.suna_account_migrations (status, heartbeat_at);` — instant on a
// 327-row table.
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_suna_account_migrations_heartbeat`);
};

// Forward-only: re-creating an index no query reads would re-impose its write cost.
export const down = false;
