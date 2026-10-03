// Migration: drop_unused_secret_handle_session_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Drops kortix.idx_secret_handles_session (project_session_secret_handles
// (session_id)) -- the Supabase performance advisor's `unused_index` finding on
// the table (observed 2026-10-02, prod, read-only Management API). Prod
// pg_stat_user_indexes shows idx_scan = 0 for it, pg_stat_database.stats_reset
// is NULL (stats were never reset), and the table carries no rows. The index is
// redundant, not merely idle: every remaining index on the table that leads
// with session_id serves the same access path, and
// idx_secret_handles_session_secret_rev (session_id, secret_id, revision) is
// one of them, so any `WHERE session_id = $1` query keeps its covering index.
//
// What still holds after the drop:
//   - The session_id foreign key's referenced-side RI query stays covered --
//     Postgres needs a valid, non-partial index leading with session_id on the
//     referencing table, and idx_secret_handles_session_secret_rev is one.
//     (Pinned by secret-handle-session-index-drop.integration.test.ts.)
//   - The three remaining indexes on the table (lookup, session_secret_rev,
//     one_active) are untouched; they are the ones the code's queries scan.
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

export const shorthands = undefined;

// mixed-version-safe: idx_secret_handles_session is a plain non-unique index
// that backs no constraint and no ON CONFLICT target, and nothing references
// it by name (code or SQL -- grepped). Dropping an index changes query plans,
// never correctness: every access path it served stays served by
// idx_secret_handles_session_secret_rev, which leads with session_id and
// remains (checked against all three query sites on the table:
// apps/api/src/projects/secrets/handles.ts, projects/routes/secret-delivery.ts,
// secrets/relay-authorize.ts). An app version already running mid-rollout
// therefore keeps working; its plans are equal or better on the remaining
// index, a superset of this one's leading column.

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
  pgm.sql(`
    drop index concurrently if exists kortix.idx_secret_handles_session
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
