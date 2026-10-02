// Migration: session_tool_approvals_fk_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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
//
// Two statements, not the template's one: the Supabase advisor reports BOTH
// foreign keys of `kortix.session_tool_approvals` as unindexed
// (`session_tool_approvals_project_id_fkey`, `session_tool_approvals_connector_id_fkey`),
// and neither index covers the other FK (the leading column must match). They
// run strictly serially below -- one `pgm.sql()` call per statement, the only
// safe order for concurrent builds on one table (learnings: 2026-08-10) -- and
// `if not exists` makes a re-run after a partial failure a no-op for what built.

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
  pgm.sql(`
    create index concurrently if not exists idx_session_tool_approvals_project_id
      on kortix.session_tool_approvals (project_id)
  `);
  pgm.sql(`
    create index concurrently if not exists idx_session_tool_approvals_connector_id
      on kortix.session_tool_approvals (connector_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
