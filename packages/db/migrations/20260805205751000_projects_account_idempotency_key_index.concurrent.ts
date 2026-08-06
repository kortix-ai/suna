// Migration: projects_account_idempotency_key_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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
  // The dedupe guarantee for POST /v1/projects/provision, not merely a lookup
  // index. The route pre-checks the key before it creates anything upstream,
  // but two concurrent provisions carrying the same key can both miss that
  // check; only a unique constraint stops the second INSERT, and the route
  // catches the resulting 23505, deletes the repo it just minted, and returns
  // the winner's project. Without this index that race silently produces the
  // duplicate project + duplicate managed repo the key exists to prevent.
  //
  // PARTIAL on `idempotency_key is not null`: every project created by any
  // other route (BYO-repo link, /create-repo, the CLI) and every pre-existing
  // row has no key, and those must stay entirely unconstrained. The predicate
  // also keeps the index tiny — it holds only rows a provision call keyed.
  //
  // ACCOUNT-SCOPED: one account's key must never collide with another's. The
  // key is caller-supplied, so a bare unique index on the key alone would let
  // any tenant deny another tenant a create by guessing a token.
  //
  // The companion .sql migration immediately before this one adds the column.
  pgm.sql(`
    create unique index concurrently if not exists idx_projects_account_idempotency_key
      on kortix.projects (account_id, idempotency_key)
      where idempotency_key is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
