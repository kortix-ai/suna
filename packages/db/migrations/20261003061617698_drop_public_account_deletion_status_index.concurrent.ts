// Migration: drop_public_account_deletion_status_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
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
//     a plain .sql migration. See MIGRATIONS.md "Roll-forward safety" for why.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails `pnpm --filter @kortix/db lint`.
//   - statement_timeout should be generous (index drops on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
// mixed-version-safe: no code reads this index or plans on it. It is the advisor
// `unused_index` finding on public.account_deletion_requests (KRTX-1218):
// idx_account_deletion_requests_status (btree on is_cancelled, is_deleted) had
// idx_scan = 0 at the 2026-10-02 observation. The table is a pre-baseline legacy
// copy -- the managed surface (baseline 20260621094136410) models
// account_deletion_requests in the kortix schema only, so a fresh database (local,
// CI, self-host) never has it and IF EXISTS makes this a no-op there. On the
// environments that predate the baseline the table is read-only (no inserts or
// updates since its stats began; 289 rows on prod, 2026-10-03) and nothing plans a
// lookup on (is_cancelled, is_deleted): every btree lookup index still carries
// scans (prod 2026-10-03: pkey 95, account_id 195, scheduled 102, user_id 87), so
// the index only costs its upkeep. The one other 0-scan index on the table,
// unique_active_deletion_request, stays: uniqueness is behaviour, and the
// advisor's unused_index lint never flags a unique index. The advisor itself
// stopped listing the table because this index collected one scan between the
// observation and the 2026-10-03 read (stats were never reset) -- exactly the
// one-off churn this drop prevents.
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
  // IF EXISTS: a fresh database never has the legacy public table, and a
  // re-run after a cancelled drop (left with no index) must stay a no-op.
  // The kortix-schema twin the baseline builds keeps its own lifecycle --
  // this drops only the legacy public copy.
  pgm.sql(`drop index concurrently if exists public.idx_account_deletion_requests_status`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
