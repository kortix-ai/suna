// Migration: sandbox_deadline_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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
//     (This file carries TWO statements by necessity: the CONCURRENTLY index
//     build and the VALIDATE CONSTRAINT of the cap added in the companion .sql
//     migration. Both are non-blocking, both must run outside a transaction,
//     and both are independently idempotent -- VALIDATE on an already-valid
//     constraint is a no-op.)
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout still matters for the brief catalog-level lock the build
//     takes at the very end; statement_timeout should be generous (index
//     builds on large tables can legitimately run long) or left unset.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

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
  pgm.sql(`set lock_timeout = '2s'`);
  // The reaper's candidate query orders by `deadline_at <= now()` over active
  // rows only, so a partial index on exactly that predicate keeps the sweep off
  // a seq scan as session_sandboxes grows.
  pgm.sql(`
    create index concurrently if not exists idx_session_sandboxes_deadline_active
      on kortix.session_sandboxes (deadline_at)
      where status = 'active'
  `);
  // Validating the NOT VALID cap from the companion .sql migration takes only a
  // SHARE UPDATE EXCLUSIVE lock (concurrent reads AND writes keep running), but
  // it must not sit inside the batch transaction while it scans the table — so
  // it shares this non-transactional file. The constraint was already enforced
  // on every new write from the moment it was added; this only proves the
  // pre-existing rows conform.
  pgm.sql(`
    alter table kortix.session_sandboxes
      validate constraint session_sandboxes_deadline_within_cap
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
