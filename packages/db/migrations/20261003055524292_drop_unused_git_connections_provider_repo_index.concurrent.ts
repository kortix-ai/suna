// Migration: drop_unused_git_connections_provider_repo_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// `idx_project_git_connections_provider_repo` (provider, external_repo_id)
// costs one index write on every insert/update of kortix.project_git_connections
// and has never served a read.
//
// PROD 2026-10-03, `pg_stat_user_indexes` with `stats_reset = null` — the
// counters have never been reset, so this covers the index's whole life:
//
//     idx_project_git_connections_provider_repo   328 kB   idx_scan 0   idx_tup_read 0   idx_tup_fetch 0
//
// The table is 3.4 MB. The siblings all work: the unique (project_id) index is
// the hot path (34M scans), the (account_id) and (status) indexes and the pkey
// are all scanned daily. No application query filters git connections by
// (provider, external_repo_id) — the column pairs are only read/written as row
// values — and nothing names the index. Supabase's performance advisor has
// reported the index as unused since 2026-10-02.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, blocks no reader and
// no writer, and only unlinks — it never rewrites the heap. lock_timeout is
// 180s for the same reason the CIC migrations use it (learnings 2026-08-19,
// "CIC under a 5-second lock_timeout"): it waits on transactions that started
// before it while blocking nobody.
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around `pnpm migrate` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     `lock_timeout` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the one lock a CONCURRENTLY build holds
//     (ShareUpdateExclusive on the table) only excludes other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails `pnpm --filter @kortix/db lint`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

// mixed-version-safe: read-path only. No application code or migration names
// `idx_project_git_connections_provider_repo`, and no query filters git
// connections by (provider, external_repo_id) — `idx_scan = 0` since the
// stats began. An old pod replaying an old query plan cannot need an index
// the planner never picked.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(
    `drop index concurrently if exists "kortix"."idx_project_git_connections_provider_repo"`,
  );
};

// Forward-only. Re-creating a 328 kB index nothing has ever read would
// re-impose the per-row write cost this migration exists to remove.
export const down = false;
